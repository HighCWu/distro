# SPDX-License-Identifier: MIT

import _posixsubprocess
import errno
import json
import multiprocessing
import os
import select
import signal
import subprocess
import sys
import tempfile
import time


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def read_pipe_to_eof(fd, timeout):
    deadline = time.monotonic() + timeout
    chunks = []
    total = 0
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out reading child pipe")
        readable, _, _ = select.select([fd], [], [], remaining)
        if not readable:
            raise TimeoutError("timed out reading child pipe")
        chunk = os.read(fd, 4096)
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > 4096:
            raise RuntimeError("child pipe payload exceeded its limit")
        chunks.append(chunk)


def wait_for_child(pid, timeout):
    deadline = time.monotonic() + timeout
    while True:
        try:
            waited, status = os.waitpid(pid, os.WNOHANG)
        except InterruptedError:
            continue
        if waited == pid:
            return status
        if time.monotonic() >= deadline:
            raise TimeoutError("timed out waiting for fork child")
        time.sleep(0.01)


def terminate_and_reap(pid):
    try:
        waited, _ = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return
    if waited == pid:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        try:
            waited, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if waited == pid:
            return
        time.sleep(0.01)
    raise TimeoutError("failed to reap terminated fork child")


def fork_child(read_fd, write_fd, parent_pid, heap, events):
    try:
        os.close(read_fd)
    except OSError:
        pass
    try:
        initial_value = heap["value"]
        heap["value"] = "child"
        payload = {
            "pid": os.getpid(),
            "ppid": os.getppid(),
            "events": list(events),
            "heap_before": initial_value,
            "heap_after": heap["value"],
            "expected_parent": parent_pid,
        }
        encoded = json.dumps(payload, sort_keys=True).encode("utf-8")
        os.write(write_fd, encoded)
        os.close(write_fd)
        os._exit(0)
    except BaseException as error:
        try:
            os.write(write_fd, ("ERROR:" + repr(error)).encode("utf-8"))
        except BaseException:
            pass
        os._exit(1)


def stage_fork():
    events = []

    def before_fork():
        events.append("before")

    def after_parent():
        events.append("parent")

    def after_child():
        events.append("child")

    os.register_at_fork(
        before=before_fork,
        after_in_parent=after_parent,
        after_in_child=after_child,
    )
    heap = {"value": "parent"}
    parent_pid = os.getpid()
    read_fd, write_fd = os.pipe()
    try:
        pid = os.fork()
    except BaseException:
        os.close(read_fd)
        os.close(write_fd)
        raise
    if pid == 0:
        fork_child(read_fd, write_fd, parent_pid, heap, events)

    os.close(write_fd)
    reaped = False
    try:
        raw_payload = read_pipe_to_eof(read_fd, 30)
        wait_status = wait_for_child(pid, 30)
        reaped = True
    except BaseException:
        terminate_and_reap(pid)
        reaped = True
        raise
    finally:
        os.close(read_fd)
        if not reaped:
            terminate_and_reap(pid)

    require(os.waitstatus_to_exitcode(wait_status) == 0, "fork child exited unsuccessfully")
    require(events == ["before", "parent"], "parent at-fork callback order")
    require(heap["value"] == "parent", "fork child changed parent heap")
    require(not raw_payload.startswith(b"ERROR:"), raw_payload.decode("utf-8", "replace"))
    payload = json.loads(raw_payload.decode("utf-8"))
    require(payload["pid"] == pid and payload["pid"] != parent_pid, "fork child PID")
    require(payload["ppid"] == parent_pid == payload["expected_parent"], "fork child PPID")
    require(payload["events"] == ["before", "child"], "child at-fork callback order")
    require(payload["heap_before"] == "parent" and payload["heap_after"] == "child",
            "fork child private heap")
    try:
        os.waitpid(pid, os.WNOHANG)
    except ChildProcessError as error:
        require(error.errno == errno.ECHILD, "second waitpid errno")
    else:
        raise AssertionError("second waitpid unexpectedly found a child")


def set_restrictive_umask():
    os.umask(0o077)


def stage_subprocess(work):
    child_cwd = os.path.join(work, "subprocess-cwd")
    os.mkdir(child_cwd)
    read_fd, write_fd = os.pipe()
    try:
        require(os.write(write_fd, b"pass-fd-payload") == len(b"pass-fd-payload"),
                "write subprocess pipe payload")
        os.close(write_fd)
        write_fd = -1
        child_program = r'''
import json
import os
import stat

fd = int(os.environ["FORK_PASS_FD"])
payload = os.read(fd, 128)
os.close(fd)
probe_fd = os.open("umask-probe", os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o666)
os.close(probe_fd)
print(json.dumps({
    "cwd": os.getcwd(),
    "value": os.environ.get("FORK_PROBE_VALUE"),
    "parent": int(os.environ["FORK_EXPECTED_PARENT"]),
    "ppid": os.getppid(),
    "pid": os.getpid(),
    "payload": payload.decode("ascii"),
    "mode": stat.S_IMODE(os.stat("umask-probe").st_mode),
}, sort_keys=True))
'''
        parent_pid = os.getpid()
        child_env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "FORK_PROBE_VALUE": "ready",
            "FORK_EXPECTED_PARENT": str(parent_pid),
            "FORK_PASS_FD": str(read_fd),
        }
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", child_program],
            cwd=child_cwd,
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=True,
            timeout=30,
            preexec_fn=set_restrictive_umask,
            pass_fds=(read_fd,),
        )
    finally:
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)

    require(result.stderr == "", "subprocess unexpectedly wrote stderr")
    payload = json.loads(result.stdout)
    require(payload["cwd"] == child_cwd, "subprocess cwd")
    require(payload["value"] == "ready", "subprocess environment")
    require(payload["pid"] != parent_pid and payload["ppid"] == parent_pid,
            "subprocess identity")
    require(payload["payload"] == "pass-fd-payload", "subprocess inherited fd")
    require(payload["mode"] == 0o600, "subprocess preexec_fn umask")
    print("python fork: subprocess preexec_fn umask, cwd, env and fd pass", flush=True)


def stage_subprocess_recovery(work):
    def raising_preexec():
        raise RuntimeError("preexec failure sentinel")

    try:
        subprocess.run(
            [sys.executable, "-I", "-B", "-c", "pass"],
            preexec_fn=raising_preexec,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except subprocess.SubprocessError as error:
        require("preexec_fn" in str(error), "preexec_fn failure diagnostic")
    else:
        raise AssertionError("raising preexec_fn unexpectedly succeeded")

    missing_executable = os.path.join(work, "missing-executable")
    try:
        subprocess.run(
            [missing_executable],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except FileNotFoundError as error:
        require(error.errno == errno.ENOENT, "missing executable errno")
        require(error.filename == missing_executable, "missing executable path")
    else:
        raise AssertionError("missing executable unexpectedly succeeded")

    failed = subprocess.run(
        [sys.executable, "-I", "-B", "-c", "raise SystemExit(23)"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    )
    require(failed.returncode == 23, "subprocess nonzero exit status")

    recovered = subprocess.run(
        [sys.executable, "-I", "-B", "-c", "print('recovered')"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
        timeout=30,
        preexec_fn=set_restrictive_umask,
    )
    require(recovered.stdout == "recovered\n" and recovered.stderr == "",
            "subprocess fork_exec recovery")
    print("python fork: subprocess failures and fork_exec recovery pass", flush=True)


def multiprocessing_child(connection, heap, parent_pid):
    initial = heap["value"]
    heap["value"] = "child"
    connection.send({
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "expected_parent": parent_pid,
        "heap_before": initial,
        "heap_after": heap["value"],
    })
    connection.close()


def stage_multiprocessing():
    context = multiprocessing.get_context("fork")
    receive_connection, send_connection = context.Pipe(duplex=False)
    parent_pid = os.getpid()
    heap = {"value": "parent"}
    process = context.Process(
        target=multiprocessing_child,
        args=(send_connection, heap, parent_pid),
    )
    started = False
    child_pid = None
    try:
        process.start()
        started = True
        child_pid = process.pid
        send_connection.close()
        require(receive_connection.poll(30), "multiprocessing child pipe timeout")
        payload = receive_connection.recv()
        process.join(30)
        if process.is_alive():
            raise TimeoutError("multiprocessing child did not exit")
        require(process.exitcode == 0, "multiprocessing child exit code")
    finally:
        receive_connection.close()
        send_connection.close()
        if started:
            if process.is_alive():
                process.terminate()
                process.join(2)
            if process.is_alive():
                process.kill()
                process.join(2)
            if process.is_alive():
                raise TimeoutError("unable to stop multiprocessing child")
            process.close()
        else:
            process.close()

    require(payload["pid"] == child_pid and payload["pid"] != parent_pid,
            "multiprocessing child PID")
    require(payload["ppid"] == parent_pid == payload["expected_parent"],
            "multiprocessing child PPID")
    require(payload["heap_before"] == "parent" and payload["heap_after"] == "child",
            "multiprocessing child private heap")
    require(heap["value"] == "parent", "multiprocessing child changed parent heap")
    print("python fork: multiprocessing fork Process Pipe and heap isolation pass",
          flush=True)


def main():
    require(hasattr(os, "fork"), "os.fork is unavailable")
    require(_posixsubprocess is not None, "_posixsubprocess import failed")
    with tempfile.TemporaryDirectory(prefix="python-fork-runtime-") as work:
        stage_fork()
        print("python fork: os.fork identity, at-fork order, private heap, pipe and wait pass", flush=True)
        stage_subprocess(work)
        stage_subprocess_recovery(work)
        stage_multiprocessing()


if __name__ == "__main__":
    main()

