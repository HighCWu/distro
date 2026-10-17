# SPDX-License-Identifier: MIT
"""Exercise timeouts, binary pipe recovery, signals and child reaping."""

import os
import select
import signal
import subprocess
import sys


STDOUT = bytes(range(256)) + b"\x00stdout\xff"
STDERR = b"\xffstderr\x00" + bytes(reversed(range(256)))


def child(ready, ignore_term):
    import time

    signal.signal(signal.SIGTERM, signal.SIG_IGN if ignore_term else signal.SIG_DFL)
    # Small writes fit even the smallest Linux pipe. Publish readiness only
    # after output and signal disposition are established; no startup sleeps.
    assert os.write(1, STDOUT) == len(STDOUT)
    assert os.write(2, STDERR) == len(STDERR)
    assert os.write(ready, b"!") == 1
    os.close(ready)
    while True:
        time.sleep(1)


def require_timeout(operation):
    try:
        operation()
    except subprocess.TimeoutExpired as error:
        return error
    raise AssertionError("live child did not report a timeout")


def exercise_lifecycle():
    for ignore_term in (False, True):
        read_fd, write_fd = os.pipe()
        process = None
        try:
            process = subprocess.Popen(
                [sys.executable, __file__, "--child", str(write_fd), str(int(ignore_term))],
                pass_fds=(write_fd,),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            os.close(write_fd)
            write_fd = None
            readable, _, _ = select.select([read_fd], [], [], 10)
            assert readable and os.read(read_fd, 1) == b"!", "child did not become ready"
            assert process.poll() is None, process.returncode
            require_timeout(lambda: process.wait(timeout=0.05))
            error = require_timeout(lambda: process.communicate(timeout=0.05))
            assert error.output == STDOUT, (error.output, STDOUT)
            assert error.stderr == STDERR, (error.stderr, STDERR)
            assert process.poll() is None, "communicate timeout killed the child"
            process.terminate()
            if ignore_term:
                # Readiness established SIG_IGN before the parent sent SIGTERM.
                require_timeout(lambda: process.wait(timeout=0.05))
                process.kill()
            output, errors = process.communicate(timeout=10)
            assert output == STDOUT, "retry lost or duplicated binary stdout"
            assert errors == STDERR, "retry lost or duplicated binary stderr"
            expected = -signal.SIGKILL if ignore_term else -signal.SIGTERM
            assert process.returncode == expected, (process.returncode, expected)
            assert process.wait(timeout=1) == expected
            try:
                result = os.waitpid(process.pid, os.WNOHANG)
            except ChildProcessError:
                pass
            else:
                raise AssertionError("completed child was not reaped: " + repr(result))
        finally:
            os.close(read_fd)
            if write_fd is not None:
                os.close(write_fd)
            if process is not None:
                try:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=10)
                finally:
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream is not None:
                            stream.close()
    print("Python process: timeout recovery, binary pipes, terminate, kill and reaping verified")


def verify_native_negative_control():
    from unittest.mock import patch

    original = subprocess.Popen.communicate

    def duplicate_output(self, *args, **kwargs):
        output, errors = original(self, *args, **kwargs)
        return output + output, errors

    with patch.object(subprocess.Popen, "communicate", duplicate_output):
        try:
            exercise_lifecycle()
        except AssertionError as error:
            assert "retry lost or duplicated binary stdout" in str(error), error
        else:
            raise AssertionError("injected duplicate output was accepted")
    print("Python process fixture: injected retry output duplication rejected")


if __name__ == "__main__":
    if len(sys.argv) == 4 and sys.argv[1] == "--child":
        child(int(sys.argv[2]), bool(int(sys.argv[3])))
    else:
        assert sys.argv[1:] in ([], ["--native-controls"]), sys.argv
        exercise_lifecycle()
        if sys.argv[1:]:
            verify_native_negative_control()
