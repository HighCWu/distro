# SPDX-License-Identifier: MIT
"""Exercise the actual Clang Linux shared driver; never emulate its dispatch."""

import json
from pathlib import Path
import shlex
import subprocess
import sys


def run(*arguments, cwd=None):
    result = subprocess.run(
        arguments, capture_output=True, text=True, check=False, cwd=cwd
    )
    if result.returncode:
        raise RuntimeError(result.stderr[-4000:])
    return result


def linker_command(result):
    commands = [
        shlex.split(line)
        for line in result.stderr.splitlines()
        if line.lstrip().startswith('"')
    ]
    return next(command for command in commands if "wasm-ld" in Path(command[0]).name)


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
        linker = linker_command(dry)
        startup = any(Path(word).name == "crt1.o" for word in linker)
        assert startup == (not shared), linker
        assert ("--table-base=3" in linker) == (not shared), linker
        assert ("-lc" in linker) == (not shared), linker
        assert ("-shared" in linker) == shared, linker
        assert ("--unresolved-symbols=import-dynamic" in linker) == shared, linker
        assert ("--whole-archive" in linker) == (not shared), linker
        (
            root / f"wasm{width}-{'shared' if shared else 'static'}-command.json"
        ).write_text(json.dumps(linker))
    # Keep executable startup and default-library selection independent. The
    # SDK's CRT archive contains original objects with Wasm export aliases.
    sysroot = root / f"wasm{width}-sysroot"
    (sysroot / "lib").mkdir(parents=True)
    crt = sysroot / "lib/crt1.o"
    exported_libc = sysroot / "lib/libc-exports.a"
    crt.touch()
    exported_libc.touch()
    for mode, startup, libc in (
        ([], True, True),
        (["-shared"], False, False),
        (["-nodefaultlibs"], True, False),
        (["-nostartfiles"], False, True),
        (["-nostdlib"], False, False),
    ):
        linker = linker_command(
            run(*common, "-###", f"--sysroot={sysroot}", *mode, str(side))
        )
        assert (str(crt) in linker) == startup, linker
        assert (str(exported_libc) in linker) == libc, linker
        for archive, expected in ((crt, startup), (exported_libc, libc)):
            if expected:
                position = linker.index(str(archive))
                assert linker[position - 1] == "--whole-archive", linker
                assert linker[position + 1] == "--no-whole-archive", linker
        assert linker.count("--whole-archive") == int(startup) + int(libc), linker
    # A missing toolchain lookup returns the bare filename. An unrelated
    # archive in the build directory must not become an implicit default lib.
    collision_directory = root / f"wasm{width}-unrelated-cwd"
    collision_directory.mkdir()
    (collision_directory / "libc-exports.a").touch()
    linker = linker_command(
        run(*common, "-###", str(side.resolve()), cwd=collision_directory)
    )
    assert not any(Path(word).name == "libc-exports.a" for word in linker), linker
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
