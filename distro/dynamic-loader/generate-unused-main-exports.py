#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Generate unrelated exported functions for dynamic-loader memory tests."""

import argparse
import pathlib


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("count", nargs="?", type=int, default=4096)
    parser.add_argument("output", nargs="?", default="unused-main-exports.c")
    args = parser.parse_args()
    if args.count <= 0:
        parser.error("count must be positive")

    output = pathlib.Path(args.output)
    with output.open("w", encoding="ascii", newline="\n") as stream:
        stream.write("// SPDX-License-Identifier: MIT\n")
        stream.write("#include <stdint.h>\n\n")
        stream.write("#if defined(__wasm__)\n")
        stream.write(
            "#define UNUSED_EXPORT(Name) __attribute__((export_name(Name), used, noinline))\n"
        )
        stream.write("#else\n")
        stream.write(
            '#define UNUSED_EXPORT(Name) __attribute__((visibility("default"), used, noinline))\n'
        )
        stream.write("#endif\n\n")
        for index in range(args.count):
            name = f"unused_main_export_{index:05d}"
            stream.write(
                f'UNUSED_EXPORT("{name}") uint32_t {name}(uint32_t Value) '
                f"{{ return Value + UINT32_C({index + 1}); }}\n"
            )


if __name__ == "__main__":
    main()
