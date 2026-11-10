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


def expand_sdk_responses(linker):
    """Expand only ClangLinux's generated profile files, never user @files."""
    result = []
    for word in linker:
        if word.startswith("@") and Path(word[1:]).name in (
            "wasm-linux-executable.rsp",
            "wasm-linux-shared.rsp",
            "wasm-linux-cxx.rsp",
        ):
            result.extend(shlex.split(Path(word[1:]).read_text()))
        else:
            result.append(word)
    return result


def profile_response(linker, path):
    argument = f"@{path}"
    assert argument in linker, (argument, linker)


def assert_relocatable_has_no_link_defaults(linker):
    assert not any(
        word.startswith("@")
        and Path(word[1:]).name.startswith("wasm-linux-")
        and Path(word[1:]).suffix == ".rsp"
        for word in linker
    ), linker
    linker = expand_sdk_responses(linker)
    assert "-r" in linker or "--relocatable" in linker, linker
    assert not any(
        Path(word).name.startswith("crt") and Path(word).name.endswith(".o")
        for word in linker
    ), linker
    assert not any(word.startswith("-l") for word in linker), linker
    assert "-lpthread" not in linker, linker
    assert "--shared-memory" not in linker, linker
    assert not any(word.startswith("--table-base") for word in linker), linker
    assert "--export=__stack_pointer" not in linker, linker
    assert "--growable-table" not in linker, linker
    assert "--whole-archive" not in linker, linker
    assert "--no-whole-archive" not in linker, linker
    assert not any(
        Path(word).name in ("libc-exports.a", "libcxx-exports.a") for word in linker
    ), linker


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
        raw_linker = linker_command(dry)
        # The standalone compiler has no SDK sysroot here. Profile response
        # files are selected only when the sysroot supplies them below.
        assert not any(
            word.startswith("@")
            and Path(word[1:]).name in (
                "wasm-linux-shared.rsp", "wasm-linux-executable.rsp"
            )
            for word in raw_linker
        ), raw_linker
        linker = expand_sdk_responses(raw_linker)
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
    relocatable_linker = linker_command(run(*common, "-###", "-r", str(side)))
    assert_relocatable_has_no_link_defaults(relocatable_linker)
    (root / f"wasm{width}-relocatable-command.json").write_text(
        json.dumps(relocatable_linker)
    )
    # Keep executable startup and default-library selection independent. The
    # SDK's CRT archive contains original objects with Wasm export aliases.
    sysroot = root / f"wasm{width}-sysroot"
    (sysroot / "lib").mkdir(parents=True)
    crt = sysroot / "lib/crt1.o"
    exported_libc = sysroot / "lib/libc-exports.a"
    executable_rsp = sysroot / "lib/wasm-linux-executable.rsp"
    shared_rsp = sysroot / "lib/wasm-linux-shared.rsp"
    crt.touch()
    exported_libc.touch()
    executable_rsp.write_text(
        shlex.join(
            [
                "--shared-memory",
                "--max-memory=16777216",
                "--growable-table",
                "--export=__stack_pointer",
                "--table-base=3",
            ]
        )
        + "\n"
    )
    shared_rsp.write_text(
        shlex.join(
            [
                "--shared-memory",
                "--max-memory=16777216",
                "--growable-table",
                "--export=__stack_pointer",
            ]
        )
        + "\n"
    )
    for mode, startup, libc in (
        ([], True, True),
        (["-shared"], False, False),
        (["-nodefaultlibs"], True, False),
        (["-nostartfiles"], False, True),
        (["-nostdlib"], False, False),
        (["-r"], False, False),
    ):
        raw_linker = linker_command(
            run(*common, "-###", f"--sysroot={sysroot}", *mode, str(side))
        )
        if mode == ["-r"]:
            assert not any(
                word.startswith("@") and Path(word[1:]).name in (executable_rsp.name, shared_rsp.name)
                for word in raw_linker
            ), raw_linker
        else:
            selected_rsp = shared_rsp if "-shared" in mode else executable_rsp
            profile_response(raw_linker, selected_rsp)
        linker = expand_sdk_responses(raw_linker)
        assert (str(crt) in linker) == startup, linker
        assert (str(exported_libc) in linker) == libc, linker
        for archive, expected in ((crt, startup), (exported_libc, libc)):
            if expected:
                position = linker.index(str(archive))
                assert linker[position - 1] == "--whole-archive", linker
                assert linker[position + 1] == "--no-whole-archive", linker
        assert linker.count("--whole-archive") == int(startup) + int(libc), linker
    dynamic_default_raw = linker_command(
        run(*common, "-###", f"--sysroot={sysroot}", str(side))
    )
    profile_response(dynamic_default_raw, executable_rsp)
    dynamic_default_linker = expand_sdk_responses(dynamic_default_raw)
    for default in (
        "--shared-memory",
        "--growable-table",
        "--export=__stack_pointer",
    ):
        assert default in dynamic_default_linker, dynamic_default_linker
    dynamic_relocatable_linker = linker_command(
        run(*common, "-###", f"--sysroot={sysroot}", "-r", str(side))
    )
    assert_relocatable_has_no_link_defaults(dynamic_relocatable_linker)
    # A missing toolchain lookup returns the bare filename. An unrelated
    # archive in the build directory must not become an implicit default lib.
    collision_directory = root / f"wasm{width}-unrelated-cwd"
    collision_directory.mkdir()
    (collision_directory / "libc-exports.a").touch()
    linker = expand_sdk_responses(linker_command(
        run(*common, "-###", str(side.resolve()), cwd=collision_directory)
    ))
    assert not any(Path(word).name == "libc-exports.a" for word in linker), linker
    output = root / f"wasm{width}-side.wasm"
    side_object = root / f"wasm{width}-side.o"
    side_partial = root / f"wasm{width}-side-partial.o"
    run(*common, "-O2", "-fPIC", "-c", str(side), "-o", str(side_object))
    run(*common, "-r", str(side_object), "-o", str(side_partial))
    run(
        *common,
        "-O2",
        "-shared",
        str(side_partial),
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
    print(
        f"shared driver wasm{width}: static/shared dispatch and real PIC partial link pass"
    )
