# SPDX-License-Identifier: MIT
"""Compare public launch errors; native patch mode only exercises PATH logic."""

import errno
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap


def subprocess_launch(executable, environment):
    subprocess.run([executable], env=environment, check=True)


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
    if sys.argv[1:]:
        check_errors(patched_path_launcher())
