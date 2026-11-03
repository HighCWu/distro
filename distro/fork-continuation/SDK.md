# Experimental static C fork SDK

This opt-in profile does not replace the default SDK. Build `sdk-fork-continuation`
or `sdk-fork-continuation-wasm64` from the distro flake. Use matching-width
runtime/kernel packages that implement the optional `linux_fork_v1` protocol.

The separate `sdk-fork-cooperative-poll` and `-wasm64` candidates combine this
profile with application-only computation checkpoints, using an explicit private
composition marker. They retain whole-link finalization and single-thread static
C limits. Libc polling and dynamic linking are not enabled by this composition;
see `../fork-poll/README.md` for its target acceptance requirements.

This profile imports `linux.syscall_v2`, whose clone arguments use the Linux
default order: flags, stack, parent TID, child TID, TLS. Only the single-thread
fork shape with `SIGCHLD` and the default child stack is supported, with the
namespace, PIDFD and TID options described below gated by matching support.
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

For Autoconf builds, select this profile's
`share/linux-wasm-fork-sdk/config.site` with the standard `CONFIG_SITE` variable
(Nix users can use the package's `configSite` attribute). It removes the default
SDK's negative fork cache answers so the normal compile/link probes can run;
it does not prefill success. The default SDK's policy is unchanged. The profile
still disables vfork, fixed/file-mapping capability probes and dynamic loading.
Every complete executable still needs the finalizer after linking.

Current supported scope: static C, fork from ordinary single-thread program
execution. Fork from a signal handler, runtime callback, or a process with sibling
threads is rejected. Dynamic modules, C++ EH/SjLj, vfork and multithreaded fork
are not supported. The fixed 256 KiB continuation buffer traps on overflow;
overflow is not a recoverable fork errno. No performance guarantee is made.

New execution objects export syscall continuation ABI 2. Use a matching runtime;
ABI-1-only loaders reject these objects, and new loaders still accept ABI 1 for
the old clone subset. Only ABI 2 enables `clone3` through the v2 import.
The v2 import adapts Linux `clone3` (435) for the same limited fork shape:
zero flags or capability-gated options below, SIGCHLD exit signal, no alternate
stack or CLONE_SETTLS flag. PID selection needs the optional transport below.
Unrequested PIDFD/TID/TLS/cgroup fields are ignored as on Linux, including
values that would not be representable or accessible as pointers on wasm32.
The u64 `clone_args` layout is identical on both pointer widths. Sizes from 64
through 65536 bytes are bounded and read-checked; unknown tail bytes must be zero.
Malformed sizes/addresses/tails return EINVAL/EFAULT/E2BIG; other unsupported
shapes return EOPNOTSUPP, not full Linux clone3 flag compatibility. The old
callback import returns ENOSYS for clone3 instead of invoking kernel clone
without a continuation. This does not extend multithread fork or raw-caller
libc cleanup guarantees. Target acceptance is recorded separately in the project.

Matching newer execution support transports CLONE_NEWNS, CLONE_NEWUTS,
CLONE_NEWIPC, CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET and CLONE_NEWCGROUP,
optionally combined with CLONE_PIDFD. Linux decides namespace configuration,
permissions and valid combinations; transport does not enable a disabled
controller or promise every namespace is available. The optional internal
execution export is refused when absent, before starting an unwind. Captured
options are cleared after a negative result or trap. CLONE_NEWTIME is refused
because legacy callback clone's CSIGNAL bits cannot represent it. The static C,
single-thread and default-stack limits remain; these additions do not introduce
an application API or libc function. Namespace target checks are independent
of previously accepted fork checks and still require actual runtime evidence.

The v2 import also accepts these namespace/PIDFD combinations through standard
flags-first `clone` (220): flags, default stack, parent_tid/PIDFD, child_tid, TLS.
SIGCHLD and the default stack are required. The CLONE_PIDFD output must fit an
int in linear memory; requested TID addresses retain their full pointer width
and Linux performs the stores. Unrequested parent/child TID and TLS registers,
and the sixth unused register, are ignored as on Linux. TLS flags remain unsupported.
Legacy flags use their low 32 bits as in kernel clone; clone3 keeps its u64 flag
field, and PIDFD pointers retain the module's full pointer width in either API.
Captured options use the same capability gates and rollback as clone3;
rewind completes the already admitted call. The callback import still uses its
original callback layout and is never inferred from numeric flag values.

With `native_clone3_fork_abi=1` from the kernel and the optional execution
object export `__wasm_fork_clone3_native`, admitted clone3 requests enter Linux's
original clone3 implementation. A private kernel/loader import supplies the
suspended child entry; without it the kernel refuses before spawning a Worker.
Older kernel/object pairs retain the existing callback transport for their
previously supported shapes. This adds no Linux syscall or libc interface.

Matching native support admits CLONE_PARENT_SETTID, CLONE_CHILD_SETTID and
CLONE_CHILD_CLEARTID through clone3. Legacy clone uses the optional execution
export `__wasm_fork_clone_options` with the kernel's existing callback syscall,
preserving number 220 rather than substituting clone3/435. It can carry those
TID flags without requiring the new native-clone3 kernel capability.
Linux performs the TID stores;
the loader does not write them. clone3 keeps PIDFD and parent_tid as separate
addresses, while legacy clone aliases that register and Linux rejects the
PIDFD/PARENT_SETTID alias. Child TIDs use the child's PID namespace; parent
TIDs use the parent's namespace. Private memory remains private, so a child
clear-TID action does not create a shared-memory wakeup facility for its parent.
CLONE_SYSVSEM additionally requires bit 4 of the private execution object's
`__wasm_fork_clone3_features`. It shares Linux's SEM_UNDO list while retaining
independent user memory. Older objects are refused before continuation unwind;
the existing CLONE_FS/CLONE_FILES bit 3 is unchanged. Linux owns undo application
at the last sharer's exit and rejects incompatible CLONE_NEWIPC combinations.
Custom stacks, TLS flags and multithreaded fork remain unsupported. Actual
target acceptance of this increment is recorded separately from host checks.

Native clone3 CLONE_NNP requires bit 5 of the execution object capability. The
flag remains u64 on wasm32 and is never substituted with a child-side prctl.
Linux installs no_new_privs before child execution and retains its standard
fork/exec inheritance and inability to clear the restriction. Older objects or
non-native clone3 transport refuse the flag before continuation unwind.

Native clone3 exit_signal values 0..64 require capability bit 6 and the private
fixed-i32 staging export for values other than SIGCHLD. Linux owns notification
and wait-class semantics; zero or non-SIGCHLD children need the corresponding
Linux __WCLONE/__WALL wait options. Every native request stages its own signal,
and the execution object consumes it once, restoring SIGCHLD even on errors.
The legacy callback/flags clone transports retain their SIGCHLD-only subset.

Native CLONE_AUTOREAP and CLONE_PIDFD_AUTOKILL require bits 7 and 8 respectively.
Linux retains flag-combination, permission and exit-signal validation. AUTOKILL
applies to the owning file description's last reference; an independent pidfd_open
does not acquire that flag. The host performs no synthetic reaping or kill.

CLONE_PARENT requires private capability bit 9 and either the native clone3 or
legacy options helper. Linux assigns the caller's real parent and its inherited
exit notification; the host does not reparent tasks. clone3 requires exit_signal
zero for this flag, retaining that field's independent transport gate. Namespace
init and invalid combinations are rejected by Linux. User memory stays private.

Native CLONE_EMPTY_MNTNS requires private capability bit 10. The execution
object preserves the u64 flag; Linux implies NEWNS and selects the empty mount
view and initial root/cwd. It retains the kernel's CLONE_FS conflict and namespace
permissions. This does not add an unshare fallback or host-side mount changes.

CLONE_IO requires private capability bit 11 and native clone3 or the legacy
options helper. It shares the existing Linux io_context with independent user
memory. An I/O context must already exist for sharing; Linux retains allocation,
permission and lifetime semantics. This does not promise host/browser physical
I/O scheduling behavior or introduce ioprio libc wrappers.

`share/linux-wasm-fork-sdk/profile.json` records the experimental profile.

CLONE_CLEAR_SIGHAND requires the optional `__wasm_fork_clone3_flags64` export
and the native kernel capability above. Its flags argument is i64 even on
wasm32; pointer arguments retain the target's pointer width. The old
`__wasm_fork_clone3_native` export keeps its original signature and low-flag
scope, so older objects are never passed a mismatched argument type.
Linux resets custom signal handlers while retaining SIG_IGN. Combining
CLEAR_SIGHAND and SIGHAND returns EINVAL; shared-handler/thread creation is not
enabled. Legacy clone keeps Linux's low-32-bit flags rule. This is execution
compatibility for the existing syscall, not a new libc interface. Target
signal/disposition and recovery evidence is tracked separately.

CLONE_INTO_CGROUP uses the optional `__wasm_fork_clone3_cgroup` transport and
bit 1 of `__wasm_fork_clone3_features`. The cgroup fd remains a u64 on both
pointer widths; Linux requires VER2 size and a value no larger than INT_MAX.
The old wide helper retains its signature and refuses this flag. Linux alone
checks the target descriptor, permissions, controller limits and rollback.
An unrequested cgroup field is ignored. This does not enable shared-memory,
custom-stack, TLS or multithreaded fork, and adds no libc/application API.

The `set_tid` vector requires native clone3 and feature bit 2, plus the optional
`__wasm_fork_clone3_set_tid`/`__wasm_fork_clone3_pid_select` exports. Before
unwind the loader captures up to 32 signed pid_t values. After unwind it stages
those values in the execution object's static buffer, outside active frames;
Linux copies them through its normal clone_args path. PID ranges, namespace
depth, permissions and collisions remain Linux decisions. Old objects refuse
before descriptor initialization. Every ordinary clone3 clears the internal
pointer/count, and an error clears the loader's captured vector. No public libc
function or application API is introduced.

CLONE_FS and CLONE_FILES require feature bit 3 and the matching options/native
transport. They share Linux cwd/umask and descriptor tables respectively; user
linear memory remains independent. Linux owns flag conflicts and resource
lifetimes. Both flags-first clone and clone3 use this gate. Old execution
objects refuse before descriptor initialization, and ordinary fork retains
its usual independent fs/file-table semantics. CLONE_VM, CLONE_THREAD and
multithreaded fork remain outside this continuation profile.

`build-materials/` retains the profile/musl recipes, compiler configuration,
Binaryen source and license, and links to the default SDK materials and selected
sources. This is a Nix store output, not a relocatable standalone SDK archive or
a complete transitive dependency license inventory. Project-owned additions are
MIT; upstream components retain their own licenses.
