# SPDX-License-Identifier: MIT
"""Compare launch errors and cleanup; native mode cannot prove the Wasm backend."""

import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap


def subprocess_launch(executable, environment):
    subprocess.run([executable], env=environment, check=True)


def open_descriptors():
    descriptors = set()
    for name in os.listdir("/proc/self/fd"):
        fd = int(name)
        try:
            os.fstat(fd)
        except OSError as error:
            # listdir's own directory descriptor has already been closed.
            assert error.errno == errno.EBADF, error
        else:
            descriptors.add(fd)
    return descriptors


def check_failed_launch_cleanup():
    with tempfile.TemporaryDirectory(prefix="python-spawn-cleanup-") as directory:
        read_fd, write_fd = os.pipe()
        try:
            assert not os.get_inheritable(read_fd)
            baseline = open_descriptors()
            for _ in range(64):
                try:
                    subprocess.Popen(
                        ["linux-wasm-spawn-error-fixture"],
                        env={"PATH": directory},
                        stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        pass_fds=(read_fd,),
                    )
                except FileNotFoundError:
                    pass
                else:
                    raise AssertionError("missing executable unexpectedly launched")
                assert not os.get_inheritable(read_fd), "pass_fds modified parent FD_CLOEXEC"
                current = open_descriptors()
                assert current == baseline, ("failed launch leaked parent descriptors", baseline, current)
            # This is a fresh fixture process with no legitimate child. Do not
            # silently reap a leaked spawn helper and make the test pass.
            try:
                child = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                pass
            else:
                raise AssertionError("failed launch left a child: " + repr(child))
        finally:
            os.close(read_fd)
            os.close(write_fd)
    print("Python spawn: repeated failed launches preserve parent fds, CLOEXEC and child cleanup")


def verify_cleanup_negative_controls():
    # Native-only injected regressions prove the guards detect actual leaked
    # descriptors and parent flag mutation. Never inject them into the target.
    from unittest.mock import patch

    original = subprocess.Popen
    for mode, expected in (
        ("fds", "failed launch leaked parent descriptors"),
        ("cloexec", "pass_fds modified parent FD_CLOEXEC"),
    ):
        leaked = []

        def broken_launch(*args, **kwargs):
            if mode == "fds":
                leaked.extend(os.pipe())
            try:
                return original(*args, **kwargs)
            finally:
                if mode == "cloexec":
                    os.set_inheritable(kwargs["pass_fds"][0], True)

        try:
            with patch.object(subprocess, "Popen", broken_launch):
                try:
                    check_failed_launch_cleanup()
                except AssertionError as error:
                    assert expected in str(error), error
                else:
                    raise AssertionError("injected cleanup regression was accepted")
        finally:
            for fd in leaked:
                os.close(fd)
    print("Python spawn fixture: injected native fd and CLOEXEC leaks rejected")


def check_descriptor_pressure():
    import resource

    baseline = open_descriptors()
    limits = resource.getrlimit(resource.RLIMIT_NOFILE)
    # Keep the fixture small even on hosts with million-fd limits. Existing
    # descriptors remain valid, and the hard limit is never changed.
    ceiling = max(baseline) + 16
    assert limits[1] == resource.RLIM_INFINITY or ceiling <= limits[1], limits
    for available in (1, 3, 5, 7):
        fillers = []
        try:
            resource.setrlimit(resource.RLIMIT_NOFILE, (ceiling, limits[1]))
            while True:
                try:
                    fillers.append(os.open(os.devnull, os.O_RDONLY))
                except OSError as error:
                    assert error.errno == errno.EMFILE, error
                    break
            for _ in range(available):
                os.close(fillers.pop())
            # Six fds are needed for the three stdio pipes, followed by the
            # launcher's error channel. Exercise partial setup at each point.
            try:
                process = subprocess.Popen(
                    [sys.executable, "-c", "raise SystemExit(99)"],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            except OSError as error:
                assert error.errno == errno.EMFILE, (available, error)
            else:
                process.communicate(timeout=10)
                raise AssertionError("descriptor pressure unexpectedly allowed launch")
        finally:
            resource.setrlimit(resource.RLIMIT_NOFILE, limits)
            for fd in fillers:
                os.close(fd)
        current = open_descriptors()
        assert current == baseline, ("descriptor pressure leaked parent descriptors", available,
                                     baseline, current)
        try:
            child = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            pass
        else:
            raise AssertionError("descriptor pressure left a child: " + repr(child))
    print("Python spawn: descriptor exhaustion preserves parent fds and child cleanup")


def verify_pressure_negative_control():
    from unittest.mock import patch

    original = subprocess.Popen
    leaked = []

    def broken_launch(*args, **kwargs):
        try:
            return original(*args, **kwargs)
        except OSError:
            leaked.append(os.dup(1))
            raise

    try:
        with patch.object(subprocess, "Popen", broken_launch):
            try:
                check_descriptor_pressure()
            except AssertionError as error:
                assert "descriptor pressure leaked parent descriptors" in str(error), error
            else:
                raise AssertionError("injected pressure leak was accepted")
    finally:
        for fd in leaked:
            os.close(fd)
    print("Python spawn fixture: injected descriptor exhaustion leak rejected")


def check_errors(launch):
    with tempfile.TemporaryDirectory(prefix="python-spawn-errors-") as directory:
        root = Path(directory)
        denied = root / "denied"
        denied.mkdir()
        command = "linux-wasm-spawn-error-fixture"
        (denied / command).write_text("not executable\n", encoding="utf-8")
        (denied / command).chmod(0o644)
        missing = root / "missing"
        not_directory = root / "not-a-directory"
        not_directory.write_text("file\n", encoding="utf-8")
        for executable in (command, os.fsencode(command)):
            for search, number in (
                (str(missing), errno.ENOENT),
                (str(denied) + os.pathsep + str(missing), errno.EACCES),
                (str(missing) + os.pathsep + str(denied), errno.EACCES),
                (str(not_directory) + os.pathsep + str(missing), errno.ENOENT),
            ):
                try:
                    launch(executable, {"PATH": search})
                except OSError as error:
                    assert error.errno == number, error
                    assert error.filename == executable, (error.filename, executable)
                else:
                    raise AssertionError("invalid executable unexpectedly launched")
    print("Python spawn: PATH error precedence and original str/bytes executable verified")


def patched_path_launcher():
    # Execute the actual added fallback branch, without claiming to test the
    # target interpreter, descriptor actions or target posix_spawn backend.
    patch = Path(__file__).with_name("process-posix-spawn.patch").read_text()
    branch = patch.split("+            if not _HAVE_FORK_EXEC:\n", 1)[1]
    branch = branch.split("\n             if (_USE_POSIX_SPAWN", 1)[0]
    body = textwrap.dedent("\n".join(line[1:] for line in branch.splitlines() if line.startswith("+")))

    class Launcher:
        def _posix_spawn(self, args, executable, environment, *unused):
            pid = os.posix_spawn(executable, args, environment)
            os.waitpid(pid, 0)
            raise AssertionError("invalid executable unexpectedly launched")

    setup = """def launch(executable, env):
    self = Launcher()
    args = [executable]
    preexec_fn = gid = gids = uid = cwd = None
    umask = process_group = -1
    restore_signals = close_fds = True
    pass_fds = ()
    start_new_session = False
    p2cread = p2cwrite = c2pread = c2pwrite = errread = errwrite = -1
"""
    namespace = {"os": os, "Launcher": Launcher}
    exec(setup + textwrap.indent(body, "    "), namespace)
    return namespace["launch"]


if __name__ == "__main__":
    assert sys.argv[1:] in ([], ["--patch-logic"]), sys.argv
    check_errors(subprocess_launch)
    check_failed_launch_cleanup()
    check_descriptor_pressure()
    if sys.argv[1:]:
        check_errors(patched_path_launcher())
        verify_cleanup_negative_controls()
        verify_pressure_negative_control()
