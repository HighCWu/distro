# SPDX-License-Identifier: MIT
"""Check allocated PTYs without fork, a controlling terminal or a shell."""

import os
import select
import stat
import sys
import termios
import time
import tty


RAW_MASTER = bytes(range(256)) * 2 + b"\x00master\xff"
RAW_SLAVE = bytes(reversed(range(256))) * 2 + b"\xffslave\x00"


def transfer(source, destination, payload):
    sent = 0
    received = bytearray()
    deadline = time.monotonic() + 5
    while sent < len(payload) or len(received) < len(payload):
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
    assert bytes(received) == payload, "PTY payload differs"
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


def negative_control():
    from unittest.mock import patch

    original = os.write

    def corrupt(fd, payload):
        if payload == RAW_MASTER:
            payload = bytes([payload[0] ^ 1]) + payload[1:]
        return original(fd, payload)

    with patch.object(os, "write", corrupt):
        try:
            exercise_pty()
        except AssertionError as error:
            assert str(error) == "PTY payload differs", error
        else:
            raise AssertionError("corrupted PTY bytes were accepted")
    print("Python PTY fixture: injected byte corruption rejected")


if __name__ == "__main__":
    assert sys.argv[1:] in ([], ["--native-controls"]), sys.argv
    exercise_pty()
    if sys.argv[1:]:
        negative_control()
