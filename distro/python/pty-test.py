# SPDX-License-Identifier: MIT
"""Exercise allocated PTYs and exec-started controlling-terminal sessions."""

import os
import json
import errno
import select
import signal
import stat
import subprocess
import sys
import termios
import time
import tty


RAW_MASTER = bytes(range(256)) * 2 + b"\x00master\xff"
RAW_SLAVE = bytes(reversed(range(256))) * 2 + b"\xffslave\x00"
SESSION_INPUT = bytes(range(256)) + b"\x00terminal-session\xff"


def transfer(source, destination, payload, expected=None):
    expected = payload if expected is None else expected
    sent = 0
    received = bytearray()
    deadline = time.monotonic() + 5
    while sent < len(payload) or len(received) < len(expected):
        remaining = deadline - time.monotonic()
        assert remaining > 0, ("PTY transfer timed out", sent, len(received))
        readable, writable, _ = select.select(
            [destination], [source] if sent < len(payload) else [], [], remaining,
        )
        if writable:
            count = os.write(source, payload[sent:])
            assert count > 0, "PTY write made no progress"
            sent += count
        if readable:
            block = os.read(destination, 4096)
            assert block, "PTY closed before completing transfer"
            received.extend(block)
    assert bytes(received) == expected, "PTY payload differs"
    assert not select.select([destination], [], [], 0)[0], "PTY has unexpected extra bytes"


def exercise_pty():
    master, slave = os.openpty()
    try:
        for fd in (master, slave):
            assert os.isatty(fd)
            assert stat.S_ISCHR(os.fstat(fd).st_mode)
            assert not os.get_inheritable(fd), "PTY descriptor lacks CLOEXEC"
            os.set_blocking(fd, False)
        assert os.ttyname(slave).startswith("/dev/pts/"), os.ttyname(slave)

        attributes = termios.tcgetattr(slave)
        attributes[3] |= termios.ICANON
        attributes[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        transfer(master, slave, b"canonical line\n")
        assert not select.select([master], [], [], 0)[0], "disabled echo still produced bytes"

        tty.setraw(slave, termios.TCSANOW)
        transfer(master, slave, RAW_MASTER)
        transfer(slave, master, RAW_SLAVE)
        termios.tcsetwinsize(slave, (37, 91))
        assert termios.tcgetwinsize(master) == (37, 91)
        termios.tcsetwinsize(master, (24, 80))
        assert termios.tcgetwinsize(slave) == (24, 80)
    finally:
        try:
            os.close(slave)
        finally:
            os.close(master)
    print("Python PTY: character devices, CLOEXEC, canonical/raw binary I/O and window size verified")


def session_child(slave):
    # This runs after exec, not in a preexec_fn or fork child. login_tty itself
    # creates the new session before acquiring the controlling terminal.
    os.login_tty(slave)
    tty.setraw(0, termios.TCSANOW)
    events = {"resize": [], "interrupt": 0}

    def resized(signum, frame):
        events["resize"].append(termios.tcgetwinsize(0))
        assert os.write(1, b"W") == 1

    def interrupted(signum, frame):
        events["interrupt"] += 1
        # Restore fully raw input before acknowledging: subsequent binary
        # input includes VINTR/VQUIT/VSUSP bytes and must not signal again.
        tty.setraw(0, termios.TCSANOW)
        assert os.write(1, b"I") == 1

    signal.signal(signal.SIGWINCH, resized)
    signal.signal(signal.SIGINT, interrupted)
    attributes = termios.tcgetattr(0)
    attributes[3] |= termios.ISIG
    attributes[6][termios.VINTR] = b"\x03"
    termios.tcsetattr(0, termios.TCSANOW, attributes)
    terminal = os.open("/dev/tty", os.O_RDWR | os.O_NOCTTY)
    try:
        identity = {
            "pid": os.getpid(), "session": os.getsid(0), "group": os.getpgrp(),
            "foreground": os.tcgetpgrp(0), "terminal": os.isatty(terminal),
            "stdio": all(os.isatty(fd) for fd in (0, 1, 2)),
        }
    finally:
        os.close(terminal)
    packet = json.dumps(identity).encode("ascii") + b"\n"
    assert os.write(1, packet) == len(packet)
    incoming = bytearray()
    while len(incoming) < len(SESSION_INPUT):
        block = os.read(0, len(SESSION_INPUT) - len(incoming))
        assert block, "terminal input closed early"
        incoming.extend(block)
    assert events == {"resize": [(41, 99)], "interrupt": 1}, events
    outgoing = bytes(incoming)[::-1]
    while outgoing:
        count = os.write(1, outgoing)
        assert count > 0
        outgoing = outgoing[count:]
    # Keep the slave alive until the parent has consumed and checked output;
    # closing it earlier makes master select readable for an EIO/hangup too.
    assert os.read(0, 1) == b"!", "terminal completion acknowledgement missing"


def exercise_session():
    master, slave = os.openpty()
    process = None
    try:
        os.set_blocking(master, False)
        process = subprocess.Popen(
            [sys.executable, __file__, "--session-child", str(slave)],
            pass_fds=(slave,), stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        os.close(slave)
        slave = None
        identity = bytearray()
        deadline = time.monotonic() + 5
        while not identity.endswith(b"\n"):
            remaining = deadline - time.monotonic()
            assert remaining > 0, "terminal child readiness timed out"
            readable, _, _ = select.select([master], [], [], remaining)
            assert readable, "terminal child readiness timed out"
            block = os.read(master, 4096)
            assert block, "terminal child closed before readiness"
            identity.extend(block)
            assert len(identity) < 4096, "terminal readiness record exceeds bound"
        try:
            record = json.loads(identity)
        except ValueError as error:
            raise AssertionError("invalid terminal readiness: " + repr(bytes(identity))) from error
        assert record["pid"] == process.pid, record
        assert record["session"] == record["group"] == record["foreground"] == process.pid, record
        assert record["terminal"] is True and record["stdio"] is True, record
        # Use actual terminal operations, not kill(pid, signal). Handshakes
        # prove each handler ran before any next phase or binary input.
        termios.tcsetwinsize(master, (41, 99))
        transfer(master, master, b"", b"W")
        transfer(master, master, b"\x03", b"I")
        transfer(master, master, SESSION_INPUT, SESSION_INPUT[::-1])
        assert os.write(master, b"!") == 1
        output, errors = process.communicate(timeout=10)
        assert process.returncode == 0 and output == errors == b"", (process.returncode, output, errors)
        try:
            child = os.waitpid(process.pid, os.WNOHANG)
        except ChildProcessError:
            pass
        else:
            raise AssertionError("terminal child was not reaped: " + repr(child))
    finally:
        try:
            if process is not None:
                try:
                    if process.poll() is None:
                        process.kill()
                    output, errors = process.communicate(timeout=10)
                    if errors:
                        sys.stderr.buffer.write(errors)
                finally:
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream is not None:
                            stream.close()
        finally:
            try:
                # After login_tty, Python errors go to the PTY, not Popen's
                # original stderr pipe. Preserve unread diagnostics on failure.
                if process is not None:
                    diagnostics = bytearray()
                    while len(diagnostics) < 65536:
                        try:
                            block = os.read(master, min(4096, 65536 - len(diagnostics)))
                        except BlockingIOError:
                            break
                        except OSError as error:
                            if error.errno == errno.EIO:
                                break
                            raise
                        if not block:
                            break
                        diagnostics.extend(block)
                    if diagnostics:
                        sys.stderr.write("PTY child console: " + repr(bytes(diagnostics)) + "\n")
            finally:
                if slave is not None:
                    os.close(slave)
                os.close(master)
    print("Python PTY session: controlling terminal, foreground group, binary I/O and reaping verified")
    print("Python PTY signals: resize and terminal-generated interrupt reach foreground child")


def negative_control():
    from unittest.mock import patch

    original = os.write

    for operation, selected, marker in (
        (exercise_pty, RAW_MASTER, "Python PTY fixture: injected byte corruption rejected"),
        (exercise_session, SESSION_INPUT, "Python PTY session fixture: injected session byte corruption rejected"),
    ):
        def corrupt(fd, payload):
            if payload == selected:
                payload = bytes([payload[0] ^ 1]) + payload[1:]
            return original(fd, payload)

        with patch.object(os, "write", corrupt):
            try:
                operation()
            except AssertionError as error:
                assert str(error) == "PTY payload differs", error
            else:
                raise AssertionError("corrupted PTY bytes were accepted")
        print(marker)

    original_read = os.read
    for selected in (b"W", b"I"):
        def corrupt_acknowledgement(fd, count):
            block = original_read(fd, count)
            return b"?" if block == selected else block

        with patch.object(os, "read", corrupt_acknowledgement):
            try:
                exercise_session()
            except AssertionError as error:
                assert str(error) == "PTY payload differs", error
            else:
                raise AssertionError("corrupted terminal signal acknowledgement was accepted")
    print("Python PTY signal fixture: injected resize and interrupt acknowledgement corruption rejected")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--session-child":
        session_child(int(sys.argv[2]))
    else:
        assert sys.argv[1:] in ([], ["--native-controls"]), sys.argv
        exercise_pty()
        exercise_session()
        if sys.argv[1:]:
            negative_control()
