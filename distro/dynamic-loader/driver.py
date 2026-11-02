# SPDX-License-Identifier: MIT
"""Exercise the actual Clang Linux shared driver; never emulate its dispatch."""

import json
from pathlib import Path
import shlex
import subprocess
import sys


def run(*arguments):
    result = subprocess.run(arguments, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result


compiler, directory = sys.argv[1:]
root = Path(directory)
main = root / "main.c"
side = root / "side.c"
main.write_text("int shared_value=10; int shared_add(int n){return n+2;}\n")
side.write_text(
    "extern int shared_value; extern int shared_add(int);\n"
    "int library_call(int n){return shared_add(n)+shared_value;}\n"
    "void *library_pointer(void){return (void*)shared_add;}\n"
)
for width in (32, 64):
    target = f"wasm{width}-unknown-linux-musl"
    common = (compiler, f"--target={target}", "-matomics", "-mbulk-memory")
    for shared in (False, True):
        args = (*common, "-###", "-fPIC", *(["-shared"] if shared else []), str(side))
        dry = run(*args)
        commands = [
            shlex.split(line)
            for line in dry.stderr.splitlines()
            if line.lstrip().startswith('"')
        ]
        linker = next(
            command for command in commands if "wasm-ld" in Path(command[0]).name
        )
        startup = any(Path(word).name == "crt1.o" for word in linker)
        assert startup == (not shared), linker
        assert ("--table-base=3" in linker) == (not shared), linker
        assert ("-lc" in linker) == (not shared), linker
        assert ("-shared" in linker) == shared, linker
        assert ("--unresolved-symbols=import-dynamic" in linker) == shared, linker
        (
            root / f"wasm{width}-{'shared' if shared else 'static'}-command.json"
        ).write_text(json.dumps(linker))
    output = root / f"wasm{width}-side.wasm"
    run(
        *common,
        "-O2",
        "-fPIC",
        "-shared",
        str(side),
        "-Wl,--shared-memory,--max-memory=16777216,--export-all",
        "-Wl,-soname,libdriver.so",
        "-o",
        str(output),
    )
    # A freestanding main supplies real Wasm functions/data and the shared table.
    run(
        *common,
        "-O2",
        "-nostdlib",
        str(main),
        "-Wl,--no-entry,--import-memory,--shared-memory,--max-memory=16777216",
        "-Wl,--export-all,--export-table,--export=__stack_pointer,--growable-table",
        "-o",
        str(root / f"wasm{width}-main.wasm"),
    )
    print(f"shared driver wasm{width}: static/shared dispatch and real PIC link pass")
