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


def check_installed_layout(paths, config):
    root = "/usr/lib/python3.13"
    expected = {
        "stdlib": root,
        "platstdlib": root,
        "purelib": root + "/site-packages",
        "platlib": root + "/site-packages",
        "include": "/usr/include/python3.13",
        "platinclude": "/usr/include/python3.13",
        "scripts": "/usr/bin",
        "data": "/usr",
    }
    for name, value in expected.items():
        assert paths.get(name) == value, (name, paths.get(name), value)
    for name in ("prefix", "exec_prefix"):
        assert config.get(name) == "/usr", (name, config.get(name))
    # Only operational fields, not historical source/build provenance. This
    # does not assert that a compiler or dynamic module loader is installed.
    for name in ("CC", "CXX", "AR", "CFLAGS", "CPPFLAGS", "LDFLAGS", "LIBS"):
        value = config.get(name)
        assert isinstance(value, str), (name, value)
        assert "/nix/store/" not in value, (name, value)
    print("Python layout: installed paths and operational flags exclude build-store paths")


if __name__ == "__main__":
    assert len(sys.argv) in (2, 3), sys.argv
    check(int(sys.argv[1]))
    if len(sys.argv) == 3:
        assert sys.argv[2] == "--installed-layout", sys.argv
        check_installed_layout(sysconfig.get_paths(), sysconfig.get_config_vars())
