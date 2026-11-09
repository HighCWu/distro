#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""List default-visible definitions in an LLVM 22 Wasm archive."""

import re
import subprocess
import sys


def fail(message):
    raise SystemExit(f"weaken-public-symbols: {message}")


if len(sys.argv) != 4:
    fail("usage: weaken-public-symbols.py LLVM_READOBJ ARCHIVE WASM_ARCH")

readobj, archive, expected_arch = sys.argv[1:]
if expected_arch not in ("wasm32", "wasm64"):
    fail(f"unsupported expected archive architecture {expected_arch!r}")
report = subprocess.run(
    [readobj, "--symbols", archive], check=True, capture_output=True, text=True
).stdout

formats = re.findall(r"^Format: (\S+)$", report, re.MULTILINE)
arches = re.findall(r"^Arch: (\S+)$", report, re.MULTILINE)
address_sizes = re.findall(r"^AddressSize: (\S+)$", report, re.MULTILINE)
if not formats or any(kind != "WASM" for kind in formats):
    fail("archive is empty or contains a non-Wasm member")
expected_size = "32bit" if expected_arch == "wasm32" else "64bit"
if (
    len(arches) != len(formats)
    or any(arch != expected_arch for arch in arches)
    or len(address_sizes) != len(formats)
    or any(size != expected_size for size in address_sizes)
):
    fail(f"archive contains an incomplete or non-{expected_arch} Wasm member")

starts = re.findall(r"^  Symbol \{$", report, re.MULTILINE)
records = re.findall(r"^  Symbol \{\n(.*?)^  \}$", report, re.MULTILINE | re.DOTALL)
if not starts or len(records) != len(starts):
    fail("truncated or unsupported llvm-readobj symbol records")

name_pattern = re.compile(r"^    Name: (.+)$", re.MULTILINE)
type_pattern = re.compile(r"^    Type: (\S+) \(0x[0-9a-fA-F]+\)$", re.MULTILINE)
flags_pattern = re.compile(r"^    Flags \[ \(0x([0-9a-fA-F]+)\)$", re.MULTILINE)
supported_types = {"FUNCTION", "DATA", "GLOBAL", "SECTION", "TAG", "TABLE"}
default_visible = set()
hidden_symbols = set()

for body in records:
    names = name_pattern.findall(body)
    types = type_pattern.findall(body)
    flags_values = flags_pattern.findall(body)
    if len(names) != 1 or len(types) != 1 or len(flags_values) != 1:
        fail("symbol record is missing Name, Type, or Flags")

    name = names[0]
    symbol_type = types[0]
    flags = int(flags_values[0], 16)
    if not name or any(char.isspace() for char in name):
        fail("symbol name is empty or cannot be represented in an objcopy list")
    if symbol_type not in supported_types:
        fail(f"unsupported Wasm symbol type {symbol_type!r}")
    # These are the Wasm symbol-table bits used by LLVM 22's readobj output.
    if flags & ~0x3FF:
        fail(f"unsupported Wasm symbol flags 0x{flags:x} for {name}")

    binding = flags & 0x3  # global=0, weak=1, local=2
    visibility = flags & 0xC  # default=0, hidden=4
    defined = not flags & 0x10
    if binding == 3 or visibility not in (0, 4):
        fail(f"unsupported binding or visibility for {name}: flags=0x{flags:x}")
    if binding == 2 or symbol_type == "SECTION":
        continue
    if visibility == 4:
        # A hidden reference in another member makes the archive-internal
        # definition non-public even if that definition lacks a local header.
        hidden_symbols.add(name)
    elif defined:
        default_visible.add(name)

symbols = sorted(default_visible - hidden_symbols)
if not symbols:
    fail("archive has no default-visible global definitions")
print("\n".join(symbols))
