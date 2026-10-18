# Experimental static C fork SDK

This opt-in profile does not replace the default SDK. Build `sdk-fork-continuation`
or `sdk-fork-continuation-wasm64` from the distro flake. Use matching-width
runtime/kernel packages that implement the optional `linux_fork_v1` protocol.

Compile separate objects, link the complete executable, then transform it once:

```sh
wasm-linux-fork-cc -O2 -c main.c -o main.o
wasm-linux-fork-cc main.o -o linked.wasm
wasm-linux-fork-finalize linked.wasm app.wasm
```

The compiler uses the fork-enabled musl and exports the required stack/TLS
globals. The finalizer uses the pinned distro Binaryen with Asyncify assertions.
Do not run or distribute `linked.wasm` as the finished fork executable. Do not
transform individual objects, transform an executable twice, strip the required
exports, or use the default SDK linker/sysroot for the final link. Ordinary
programs executed by `exec` may still use the default SDK without Asyncify.

Current supported scope: static C, fork from ordinary single-thread program
execution. Fork from a signal handler, runtime callback, or a process with sibling
threads is rejected. Dynamic modules, C++ EH/SjLj, vfork and multithreaded fork
are not supported. The fixed 256 KiB continuation buffer traps on overflow;
overflow is not a recoverable fork errno. No performance guarantee is made.

`share/linux-wasm-fork-sdk/profile.json` records the experimental profile.
`build-materials/` retains the profile/musl recipes, compiler configuration,
Binaryen source and license, and links to the default SDK materials and selected
sources. This is a Nix store output, not a relocatable standalone SDK archive or
a complete transitive dependency license inventory. Project-owned additions are
MIT; upstream components retain their own licenses.
