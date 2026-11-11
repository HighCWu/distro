#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Emit an LLD #STUB library listing function exports from Wasm providers."""

import argparse
from pathlib import Path
import sys


WASM_HEADER = b"\x00asm\x01\x00\x00\x00"
MAX_WASM_SECTION_ID = 13  # The Tag section used by exception handling.


class WasmFormatError(ValueError):
    pass


def read_exact(stream, size, limit, description):
    position = stream.tell()
    if size < 0 or position > limit or size > limit - position:
        raise WasmFormatError(f"{description} exceeds its enclosing section")
    data = stream.read(size)
    if len(data) != size:
        raise WasmFormatError(f"truncated {description}")
    return data


def read_u32_leb(stream, limit, description):
    value = 0
    for index in range(5):
        byte = read_exact(stream, 1, limit, description)[0]
        payload = byte & 0x7F
        if index == 4 and payload > 0x0F:
            raise WasmFormatError(f"{description} overflows u32")
        value |= payload << (index * 7)
        if byte & 0x80 == 0:
            return value
    raise WasmFormatError(f"{description} has an overlong u32 LEB128 encoding")


def read_export_name(stream, section_end):
    length = read_u32_leb(stream, section_end, "export name length")
    raw_name = read_exact(stream, length, section_end, "export name")
    try:
        return raw_name.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise WasmFormatError("export name is not valid UTF-8") from error


def validate_stub_symbol(name):
    if not name:
        raise WasmFormatError("function export has an empty name")
    if name.startswith("#"):
        raise WasmFormatError("function export name would be parsed as an LLD #STUB comment")
    if name[0].isspace() or name[-1].isspace():
        raise WasmFormatError("function export name has leading or trailing whitespace")
    if any(character in name for character in ("\n", "\r", "\x00", ":", ",")):
        raise WasmFormatError("function export name contains a character not representable in LLD #STUB syntax")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in name):
        raise WasmFormatError("function export name contains a control character")


def read_function_exports(path):
    try:
        stream = path.open("rb")
    except OSError as error:
        raise WasmFormatError(f"cannot read provider: {error}") from error

    with stream:
        stream.seek(0, 2)
        file_size = stream.tell()
        stream.seek(0)
        header = read_exact(stream, len(WASM_HEADER), file_size, "Wasm header")
        if header != WASM_HEADER:
            raise WasmFormatError("provider is not a WebAssembly version 1 module")

        exports = set()
        seen_sections = set()
        export_section_seen = False
        while stream.tell() < file_size:
            section_id = read_exact(stream, 1, file_size, "section id")[0]
            if section_id > MAX_WASM_SECTION_ID:
                raise WasmFormatError(f"unknown WebAssembly section id {section_id}")
            section_size = read_u32_leb(stream, file_size, "section size")
            section_start = stream.tell()
            if section_size > file_size - section_start:
                raise WasmFormatError("section exceeds provider file bounds")
            section_end = section_start + section_size

            if section_id != 0:
                if section_id in seen_sections:
                    raise WasmFormatError(f"duplicate WebAssembly section id {section_id}")
                seen_sections.add(section_id)

            if section_id != 7:
                stream.seek(section_end)
                continue

            if export_section_seen:
                raise WasmFormatError("duplicate WebAssembly export section")
            export_section_seen = True
            export_count = read_u32_leb(stream, section_end, "export count")
            for _ in range(export_count):
                name = read_export_name(stream, section_end)
                kind = read_exact(stream, 1, section_end, "export kind")[0]
                if kind > 4:
                    raise WasmFormatError(f"invalid WebAssembly export kind {kind}")
                read_u32_leb(stream, section_end, "export index")
                if kind == 0:
                    validate_stub_symbol(name)
                    exports.add(name)

            if stream.tell() != section_end:
                raise WasmFormatError("trailing bytes in WebAssembly export section")

        if stream.tell() != file_size:
            raise WasmFormatError("provider has trailing bytes outside its sections")
        return exports


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("providers", nargs="+", type=Path, help="linked WebAssembly provider modules")
    parser.add_argument("-o", "--output", type=Path, help="output #STUB file (default: stdout)")
    arguments = parser.parse_args(argv)

    exports = set()
    for provider in arguments.providers:
        try:
            exports.update(read_function_exports(provider))
        except (OSError, WasmFormatError) as error:
            parser.exit(2, f"write-import-stub: {provider}: {error}\n")

    output = "#STUB\n" + "".join(f"{name}\n" for name in sorted(exports))
    encoded_output = output.encode("utf-8")
    try:
        if arguments.output is None:
            sys.stdout.buffer.write(encoded_output)
        else:
            arguments.output.write_bytes(encoded_output)
    except OSError as error:
        parser.exit(2, f"write-import-stub: cannot write output: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
