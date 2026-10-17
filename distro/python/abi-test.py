# SPDX-License-Identifier: MIT
"""Check the running interpreter, not merely a package or executable name."""

import struct
import sys
import sysconfig


def check(bits):
    assert bits in (32, 64), bits
    size = bits // 8
    for code in ("P", "n", "N", "l", "L"):
        assert struct.calcsize(code) == size, (code, struct.calcsize(code), size)
    assert sys.maxsize == 2 ** (bits - 1) - 1, sys.maxsize
    for name in ("SIZEOF_VOID_P", "SIZEOF_SIZE_T", "SIZEOF_LONG"):
        assert sysconfig.get_config_var(name) == size, (
            name,
            sysconfig.get_config_var(name),
            size,
        )
    # Pointer-sized conversions must preserve values above 4 GiB on wasm64.
    value = 0x100000007 if bits == 64 else 0x7FFFFFFF
    assert struct.unpack("P", struct.pack("P", value)) == (value,)
    print("Python ABI: pointer, size_t, long and sysconfig match %d bits" % bits)


if __name__ == "__main__":
    assert len(sys.argv) == 2, sys.argv
    check(int(sys.argv[1]))
