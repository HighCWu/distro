# SPDX-License-Identifier: MIT
"""Run with the Python environment containing the SDK's patched Meson."""
from types import SimpleNamespace

from mesonbuild.compilers.c import ClangCCompiler
from mesonbuild.compilers.mixins.clike import CLikeCompilerArgs
from mesonbuild.linkers.linkers import LLVMDynamicLinker
from mesonbuild.mesonlib import MachineChoice

for architecture in ("wasm32", "wasm64", "x86_64", "aarch64"):
    compiler = object.__new__(ClangCCompiler)
    compiler.linker = object.__new__(LLVMDynamicLinker)
    compiler.for_machine = MachineChoice.HOST
    compiler.environment = SimpleNamespace(
        machines={MachineChoice.HOST: SimpleNamespace(cpu_family=architecture)}
    )
    compiler.get_default_include_dirs = lambda: []
    compiler.unix_args_to_native = lambda args: list(args)
    arguments = CLikeCompilerArgs(compiler, ["-lfirst", "-lsecond"]).to_native()
    grouped = architecture not in ("wasm32", "wasm64")
    assert ("-Wl,--start-group" in arguments) == grouped, (architecture, arguments)
    assert ("-Wl,--end-group" in arguments) == grouped, (architecture, arguments)
    assert [arg for arg in arguments if arg.startswith("-l")] == ["-lfirst", "-lsecond"]
print("Meson archive grouping: both Wasm widths omit groups; native targets retain them")
