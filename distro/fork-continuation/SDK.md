# Experimental static C fork SDK

This opt-in profile does not replace the default SDK. Build `sdk-fork-continuation`
or `sdk-fork-continuation-wasm64` from the distro flake. Use matching-width
runtime/kernel packages that implement the optional `linux_fork_v1` protocol.

This profile imports `linux.syscall_v2`, whose clone arguments use the Linux
default order: flags, stack, parent TID, child TID, TLS. Only the single-thread
fork shape (`SIGCHLD` with the other five-argument fields zero) is supported.
The unused sixth syscall register is ignored. The existing pthread callback
clone explicitly retains `linux.syscall`; import versions, not argument values,
select the ABI. The default SDK continues to use the original import.

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

New execution objects export syscall continuation ABI 2. Use a matching runtime;
ABI-1-only loaders reject these objects, and new loaders still accept ABI 1 for
the old clone subset. Only ABI 2 enables `clone3` through the v2 import.
The v2 import adapts Linux `clone3` (435) for the same limited fork shape:
zero flags, SIGCHLD exit signal, no alternate stack, tid/pidfd/TLS/cgroup options.
The u64 `clone_args` layout is identical on both pointer widths. Sizes from 64
through 65536 bytes are bounded and read-checked; unknown tail bytes must be zero.
Malformed sizes/addresses/tails return EINVAL/EFAULT/E2BIG; other unsupported
shapes return EOPNOTSUPP, not full Linux clone3 flag compatibility. The old
callback import returns ENOSYS for clone3 instead of invoking kernel clone
without a continuation. This does not extend multithread fork or raw-caller
libc cleanup guarantees. Target acceptance is recorded separately in the project.

`share/linux-wasm-fork-sdk/profile.json` records the experimental profile.
`build-materials/` retains the profile/musl recipes, compiler configuration,
Binaryen source and license, and links to the default SDK materials and selected
sources. This is a Nix store output, not a relocatable standalone SDK archive or
a complete transitive dependency license inventory. Project-owned additions are
MIT; upstream components retain their own licenses.
