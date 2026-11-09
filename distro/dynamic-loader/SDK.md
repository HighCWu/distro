<!-- SPDX-License-Identifier: MIT -->

# Experimental Linux/Wasm dynamic loading profile

`sdk-dynamic-loader` and `sdk-dynamic-loader-wasm64` provide
`wasm-linux-dlopen-cc` for a static C main with the existing musl
`dlopen`, `dlsym`, `dlerror` and resident `dlclose` paths enabled.
The normal SDK stays unchanged. This is not an ELF format or stable new file ABI.

Use the same compiler for main sources, PIC objects and shared libraries.
For example, build an executable with `wasm-linux-dlopen-cc main.c -o main`,
compile a library object with `wasm-linux-dlopen-cc -fPIC -c library.c -o library.o`,
then link it with `wasm-linux-dlopen-cc -shared library.o -Wl,-soname,libexample.so -o libexample.so`.
Clang expands response files and selects the appropriate link mode. The SDK
provides the shared-memory limits, exports and stack configuration.

The C++ candidate provides `wasm-linux-dlopen-c++` for a static C++ main and
shared libraries using the same libc++, libc++abi and libunwind instance.

```sh
wasm-linux-dlopen-c++ -std=c++17 main.cc -o main
wasm-linux-dlopen-c++ -std=c++17 -fPIC -shared plugin.cc -o plugin.so
```

Main links export the complete C++ runtime archive. Shared links import their
runtime functions and the main's canonical exception tags. PIC typed catches
obtain the main thread's landing-pad context through the libunwind accessor;
ordinary main code keeps its existing TLS lowering. The compiler and runtime
patch are applied together within this optional SDK. The C++ configuration
selects the WebAssembly destructor ABI and applies unwinder selection during
linking, so compile-only jobs can use `-Werror`.

The C++ driver checks and four-stage consumer cover library string allocation,
typed exceptions in both directions, callback rethrow, RAII cleanup and process
exit. Native references and lightweight Wasm tag tests have passed. Patched LLVM,
Linux/Wasm execution and browser acceptance still need their target results.

Configure GNU Autoconf consumers with the profile's installed site file and
the standard `CONFIG_SITE` variable.

```sh
CONFIG_SITE=/path/to/sdk/share/linux-wasm-dynamic-sdk/config.site \
  CC=wasm-linux-dlopen-cc ./configure --host=wasm32-unknown-linux-musl
```

The file disables `fork`, `vfork` and their `*_works` probes. It reports that
the complete fixed, file-backed mapping contract tested by `AC_FUNC_MMAP` is
unavailable. It leaves `dlopen` cache answers unset so Autoconf can confirm
the enabled musl loader with its normal compile/link probes. The
libtool search-path caches are set to the target's `/lib` and `/usr/lib`, so
build-host loader paths do not enter target libraries. The SDK's `configSite`
passthru attribute points to this same installed file.

The SDK uses the Linux shared-link driver branch that selects relocatable
table placement and dynamic imports for shared libraries. Main startup comes
from its sysroot CRT archive. The default libc export archive carries the
private execution support and the libc definitions needed by side libraries.
Explicit user library
inputs remain available, and a later stricter unresolved-symbol policy wins.
The compiler's `-nostdlib`, `-nostartfiles` and `-nodefaultlibs` switches control
the corresponding startup and default-library inputs. In particular,
`-nostartfiles` keeps the runtime helpers while omitting the CRT entry point.

`sdk-dynamic-loader-check-driver` and the wasm64 equivalent exercise the built
SDK compiler with nested response files, an ordinary main and a PIC library,
including startup/default-library switches and the signal restorer export.
`dynamic-driver-check-build` separately exercises the underlying Clang branch.
These compiler and engine checks require their own Linux process acceptance.
Relocatable `-r` links combine PIC objects before a later executable or shared
link. The driver selects startup, default libraries and executable memory/table
defaults during final links. Response files follow the same selection rules.
The partial-link candidate has lightweight Clang/LLD reference coverage;
built-SDK and Linux process acceptance remain separately tracked.

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

The execution model uses a single-thread static main and numeric C/SIMD
side-module graphs, including cyclic dependencies. The C++ candidate uses the
same execution boundary. Each object is instantiated once; all
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
needs matching Linux process acceptance for this source version; it does not add Worker
creation, imported/public TLS bindings or general dynamic TLS support.

The constructor candidate publishes relocated groups and global definitions
before running their constructors. A constructor may then load another graph,
reopen a running parent, or finish a pending shared dependency. Initialization
state is shared across groups; running/completed constructors are skipped and
failed ones stay poisoned. Constructor reentry is verified in the nine-stage
1894258 Linux/Node and browser profile. File I/O, allocator callbacks and Wasm start sections retain
the recursive-loading guard until their graph is ready.

`RTLD_NEXT` lookup and imported-function re-exports are implemented. `RTLD_LAZY`
can defer direct function imports; a module that requires an unavailable GOT
relocation is still rejected. Reference-value function signatures, ELF
symbol-version tables and `dlvsym`, cross-module setjmp/longjmp and cross-Worker
publication remain outside the accepted profile. C++ exception support is a new
candidate whose target acceptance is tracked separately.
Linux names and paths preserve their original bytes. Valid UTF-8 remains Unicode;
undecodable bytes use reversible private host escapes. A leading BOM is a name
character, including in Wasm dependency metadata. Strings stay bounded to 4096
bytes; Wasm metadata still requires valid UTF-8 and does not admit escaped bytes.

Handles now point to allocator-backed `struct link_map` objects, so the
existing musl `dlinfo(RTLD_DI_LINKMAP)` body returns readable metadata. The
main and every dependency appear once in the bidirectional resident list;
inode aliases keep the same handle and name. A dependency handle searches
only its own dependency scope. The SDK asserts the five-word C layout.
`l_addr` describes the module's linear data base; `l_ld` is NULL because
these files have no ELF dynamic section. This is not ELF loading or program
header support. The ten-stage profile at 6b1777e passed Node acceptance. The
current 13-stage profile at 5202cce still needs actual Node and browser
acceptance; the earlier result does not cover the newer code. No new musl
wrapper or public header is added. The private
`linux_dlopen_v1.link_map_abi` import makes older hosts reject this SDK before
exec commits, rather than accepting it with the old integer-handle behavior.
UTF-8 decoding uses an owned byte snapshot, since browser TextDecoder
implementations can reject views over shared Wasm memory even when isolated.
Individual files and new graph input are bounded to 64 MiB, with at most 1024 cached
objects. These are profile capacities, not Linux syscall limits.

Pre-initialization failures report through the existing dlerror path. After
Wasm start/relocation/constructor side effects, a trap ends the process instead
of claiming rollback; exit/exec control transfers keep their normal path.
Main-symbol dlsym during a Wasm start callback allocates canonical pointers
outside the batch's table publication range, preserving the module's elements.
This does not enable dlopen from a Wasm start section or expose a graph before
its instances and relocations are ready.
Forward references between Wasm modules use a matching Wasm function signature
and a mutable target table index. Scalar and v128 arguments remain in Wasm;
binding the canonical provider slot precedes relocation and constructors.
Calling an unbound/weak-undefined target traps through the null table slot.
This does not make JavaScript host callbacks accept SIMD arguments.
Default CONFIG_MMU=n and bounded direct memory remain in force. Independent
execution code is MIT; musl and all dependencies retain their licenses.

Actual Linux/Wasm Node and browser acceptance must be recorded separately.
Building the recipe or running host models does not establish those results.
