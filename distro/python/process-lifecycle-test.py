# SPDX-License-Identifier: MIT
"""Exercise timeouts, binary pipe recovery, signals and child reaping."""

import os
import fcntl
import select
import signal
import subprocess
import sys


STDOUT = bytes(range(256)) + b"\x00stdout\xff"
STDERR = b"\xffstderr\x00" + bytes(reversed(range(256)))
LARGE_STDOUT = bytes(range(256)) * 2048 + b"\x00stdout-end\xff"
LARGE_STDERR = bytes(reversed(range(256))) * 2048 + b"\xffstderr-end\x00"
LARGE_INPUT = bytes(range(256)) * 2048 + b"\x00input-end\xff"


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


def duplex_child():
    # Write both streams before reading stdin. The parent verifies each stream
    # exceeds its actual pipe capacity, not an assumed default page size.
    sys.stdout.buffer.write(LARGE_STDOUT)
    sys.stdout.buffer.flush()
    sys.stderr.buffer.write(LARGE_STDERR)
    sys.stderr.buffer.flush()
    incoming = sys.stdin.buffer.read()
    sys.stdout.buffer.write(incoming[::-1])
    sys.stderr.buffer.write(b"input-bytes=" + str(len(incoming)).encode("ascii") + b"\n")


def exercise_backpressure():
    process = subprocess.Popen(
        [sys.executable, __file__, "--duplex"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        pipesize=4096,
    )
    try:
        for stream, data in ((process.stdin, LARGE_INPUT), (process.stdout, LARGE_STDOUT),
                             (process.stderr, LARGE_STDERR)):
            capacity = fcntl.fcntl(stream.fileno(), fcntl.F_GETPIPE_SZ)
            assert 0 < capacity < len(data), (capacity, len(data))
        output, errors = process.communicate(LARGE_INPUT, timeout=20)
        assert process.returncode == 0, (process.returncode, errors[-512:])
        assert output == LARGE_STDOUT + LARGE_INPUT[::-1], "large duplex stdout lost or duplicated bytes"
        expected_errors = LARGE_STDERR + b"input-bytes=" + str(len(LARGE_INPUT)).encode("ascii") + b"\n"
        assert errors == expected_errors, "large duplex stderr or input byte count differs"
        try:
            result = os.waitpid(process.pid, os.WNOHANG)
        except ChildProcessError:
            pass
        else:
            raise AssertionError("duplex child was not reaped: " + repr(result))
    finally:
        try:
            if process.poll() is None:
                process.kill()
            process.wait(timeout=10)
        finally:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
    print("Python process: large duplex binary pipes preserve backpressure, bytes and child cleanup")


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

    def truncate_input(self, incoming=None, *args, **kwargs):
        return original(self, incoming[:-1] if incoming else incoming, *args, **kwargs)

    with patch.object(subprocess.Popen, "communicate", truncate_input):
        try:
            exercise_backpressure()
        except AssertionError as error:
            assert "large duplex stdout lost or duplicated bytes" in str(error), error
        else:
            raise AssertionError("injected input truncation was accepted")
    print("Python process fixture: injected duplex input truncation rejected")


if __name__ == "__main__":
    if sys.argv[1:] == ["--duplex"]:
        duplex_child()
    elif len(sys.argv) == 4 and sys.argv[1] == "--child":
        child(int(sys.argv[2]), bool(int(sys.argv[3])))
    else:
        assert sys.argv[1:] in ([], ["--native-controls"]), sys.argv
        exercise_lifecycle()
        exercise_backpressure()
        if sys.argv[1:]:
            verify_native_negative_control()
