<!-- SPDX-License-Identifier: MIT -->

# Experimental Linux/Wasm dynamic loading profile

`sdk-dynamic-loader` and `sdk-dynamic-loader-wasm64` provide
`wasm-linux-dlopen-cc` for a static C main with the existing musl
`dlopen`, `dlsym`, `dlerror` and resident `dlclose` paths enabled.
The normal SDK stays unchanged. This is not an ELF format or stable new file ABI.

Compile main sources normally with this compiler. Compile side objects using
`-fPIC -c`, then use the SDK's ordinary `wasm-ld -m wasm32` (or `-m wasm64`)
with `--shared --no-entry --unresolved-symbols=import-dynamic`,
`--shared-memory --import-memory --import-table`, the platform's maximum memory,
SONAME and exports. The runtime recipe demonstrates the exact commands.
The current Linux Clang driver still injects a static `--table-base` for shared
links, so the general-purpose `cc -shared` path requires a separate driver fix.
No application source calls a private loader API. Main linking includes libc
and exports its definitions, as needed by side libraries.

`dynamic-driver-check-build` separately builds a candidate Clang with the
Linux shared-link branch corrected: no executable crt1, no fixed table base,
and no implicit static system archives in side modules. Explicit user library
inputs remain available; system/runtime imports resolve from the main module.
The shared driver selects dynamic unresolved imports before explicit linker
arguments, so a user's later stricter unresolved-symbol policy still wins.
It checks static/shared driver commands and links and instantiates real PIC
libraries in both widths. This candidate does not change the default compiler
or this SDK wrapper's configuration, and its engine checks are not Linux
process or ELF acceptance.

Library files are opened through Linux in the process's credentials, not host
fetch. Direct paths, LD_LIBRARY_PATH, direct-dependency RUNPATH/$ORIGIN and
/lib:/usr/lib are searched. Secure execution ignores LD_LIBRARY_PATH. Files are
deduplicated by device/inode, and live objects/constructors are reused. Main and
RTLD_GLOBAL definitions precede a newly loaded group for binding; explicit
handle lookup searches that object's group. RTLD_LOCAL, GLOBAL, NOLOAD and
NODELETE are accepted. Objects remain resident through close, matching musl's
existing policy; dynamic unloading is not implemented.
Search advances past ENOENT, ENOTDIR, EACCES or ENAMETOOLONG only when opening
the candidate failed. Other open errors stop search. Once a file is opened,
admission, read, allocation and format failures stop loading instead of silently
substituting a later same-name library. Failure cleanup permits a later retry.
An mm-owned kernel file reference retains each inode after the temporary input
fd closes. Close-range operations cannot release these references; exec/exit
teardown releases them without calling old user code. Older kernels without
this private execution capability reject the profile before exec commits.

This first profile supports single-thread static C mains and numeric C/SIMD side-module
graphs, including cyclic dependencies. Each object is instantiated once; all
GOT bindings and data relocations precede the constructor pass. Constructors
follow dependency DFS postorder, skipping already visited edges. A cycle has
no universal dependency-before-dependent order; its members must tolerate peers
whose constructors have not run yet. Reopening a resident cycle does not rerun
constructors. It refuses clone/clone3 rather than creating Workers with
missing modules. It cannot combine with the fork-continuation SDK.

The initial-thread TLS candidate admits defined hidden/local TLS objects in
LLD's module data image. All GOT bindings and ordinary/TLS pointer relocations
precede constructors; resident reuse preserves this thread's values. Runtime
checks keep the TLS image within its module allocation. TLS globals and init
helpers are not published as ordinary data/function symbols. This path still
needs the new seven-stage Linux process acceptance; it does not add Worker
creation, imported/public TLS bindings or general dynamic TLS support.

Reentrant dlopen during constructors, RTLD_NEXT, reference-value
function signatures, dynamic symbol versions, cross-module setjmp/longjmp and C++ exceptions
and cross-Worker publication still need implementation and acceptance.
Names/paths currently use UTF-8; strings are bounded to 4096 bytes.
UTF-8 decoding uses an owned byte snapshot, since browser TextDecoder
implementations can reject views over shared Wasm memory even when isolated.
Individual files and new graph input are bounded to 64 MiB, with at most 1024 cached
objects. These are profile capacities, not Linux syscall limits.

Pre-initialization failures report through the existing dlerror path. After
Wasm start/relocation/constructor side effects, a trap ends the process instead
of claiming rollback; exit/exec control transfers keep their normal path.
Main-symbol dlsym during a Wasm start callback allocates canonical pointers
outside the batch's table publication range, preserving the module's elements.
This does not enable recursive dlopen or expose the uncommitted object's handle.
Forward references between Wasm modules use a matching Wasm function signature
and a mutable target table index. Scalar and v128 arguments remain in Wasm;
binding the canonical provider slot precedes relocation and constructors.
Calling an unbound/weak-undefined target traps through the null table slot.
This does not make JavaScript host callbacks accept SIMD arguments.
Default CONFIG_MMU=n and bounded direct memory remain in force. Independent
execution code is MIT; musl and all dependencies retain their licenses.

Actual Linux/Wasm Node and browser acceptance must be recorded separately.
Building the recipe or running host models does not establish those results.
