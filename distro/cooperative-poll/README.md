<!-- SPDX-License-Identifier: MIT -->

# Cooperative user execution: compiler component

This is an experimental, independently selected execution profile. The default
SDK is unchanged. `sdk-cooperative-poll` and `sdk-cooperative-poll-wasm64` use
the ordinary compiler commands with automatic instrumentation; applications
use standard Linux/libc APIs without adding checkpoint calls.

Clang's existing `-fsanitize-coverage=trace-pc,no-prune,edge` inserts calls without
application source changes. The MIT execution object uses native Wasm TLS to
batch 4096 compiler callbacks before `linux_user_poll_v1.checkpoint`. It avoids
TLS access before initialization and resets the budget before nonlocal control
flow. The compiler hook is hidden and has no public libc declaration.

The lightweight probe executes Clang 18/22 wasm32/64 artifacts, two instances
sharing memory with distinct TLS, pre-TLS calls, batching, unsupported-host
refusal, and nonlocal callback recovery. Without instrumentation the same pure
compute workload fails the polling assertion. This does not establish Linux
timer/signal delivery, parallel Worker scheduling, or an overhead bound.

The Worker calls the kernel's private interrupt-return entry, preserving the
syscall tracing/policy boundary. It defers live allocator/startup callbacks and
rejects mixing this profile with dynamic loading or continuation fork. Handler
checkpoints require the private `user_poll_nested_v1` kernel capability; older
kernels keep deferring them. Signal handlers inside allocator callbacks still
defer pending work. Kernels without the original entry reject exec.

Only application compilation units use the coverage flag. Existing libc and
startup libraries remain uninstrumented: ordinary pthread startup initializes
its native TLS before entering instrumented application code. Do not rebuild
libc/startup code with this profile or insert instrumented callbacks before TLS
initialization. A nonzero TLS base alone is insufficient to establish ownership
during early clone startup. Raw custom clone startup needs separate review.

`WASM_POLL_THREAD_GLOBAL` is a compiler-component prototype for eventually
instrumenting library code. It selects private ABI 2 and imports a mutable,
pointer-width `linux_user_poll_v2.thread_pointer` global. Zero defers before any
TLS access. A TLS owner word, claimed once before clone publishes the block,
prevents a child temporarily using its parent's TLS from spending the parent's
budget. The owner remains read-only after that claim, including while another
instance inspects it. New native TLS starts with no owner and a fresh budget.

The separate `sdk-cooperative-poll-libc` / `sdk-cooperative-poll-libc-wasm64`
candidates select ABI 2 and rebuild the same musl source with coverage. The
Worker starts each instance's TP global at zero, publishing the actual kernel
value after TLS installation, clone's gettid boundary, or an existing TP read.
Unrelated early exec syscalls cannot publish the old image's TP. Admission
requires both ABI 2 imports, refuses mixed versions and checks the exported ABI.
Allocator/startup callbacks suspend that global before any compiler TLS access;
nested calls and nonlocal exits restore it without publishing a TP mid-callback.

Clone and pthread/C11 startup translation units remain uninstrumented until
native TLS has been initialized. This also avoids reading an inherited TLS
block after the parent could release it. Other C library compilation units are
instrumented; the compiler runtime and C++ libraries are not rebuilt with
coverage. The default and application-only SDKs are unchanged. Raw custom clone
startup still needs separate review.
The candidate's independent Wasm compatibility patch clears native TLS base
before detached self-unmap frees its stack/TLS for reuse. It preserves the
separate Linux/musl TP during exit and adds no libc function or declaration.

`cooperative-poll-libc-check-both` requires both widths to complete the five
ordinary stages and a sixth stage in a real libc memchr loop. That stage's caller
has no compiler checkpoints and uses a volatile function pointer to prevent
builtin substitution. The timer must arrive during the search interval; later
ordinary polling must recover. The small artifact/IR probes are prerequisites,
not Linux acceptance. These candidates require actual six-stage and shutdown
results before library polling is accepted. This is an execution ABI, not a new
application or libc interface.

The `cooperative-poll-check-both` target verifies real Linux timer delivery in
pure computation, siglongjmp and later recovery, targeted pthread signals and
TLS isolation, and a strict-seccomp child with a pure loop and raw thread exit.
It adds a fifth stage where a handler's syscall-free loop receives an unblocked
second timer signal, then ordinary timer delivery recovers. It must finish all
five stages and machine shutdown before acceptance. Local
compiler/host models do not establish this target result.

`cooperative-poll-cpu` and `cooperative-poll-cpu-wasm64` pair the same application
SDK with the existing separate generic virtual CPU-accounting kernel. They add
ITIMER_VIRTUAL and ITIMER_PROF delivery from a syscall-free loop and require
user CPU-time accumulation. `cooperative-poll-cpu-check-both` also includes the
ordinary accounting configuration's two runtimes (five ordinary stages, seven
GEN stages with nested handlers). This changes no default
kernel configuration. Generic accounting measures logical scheduled intervals;
it does not subtract host pauses/GC or promise native physical CPU accuracy.

The consumer marks the compute interval and refuses a signal received before
that interval. The child publishes its readiness from inside the loop, so a
targeted signal cannot pass merely by arriving at thread startup.

Other uninstrumented libraries, custom coverage hooks, C++ exception
interaction, dynamic loading, fork combinations and overhead need separate
treatment. The current candidate primarily covers static C and ordinary pthread
application entries. No public libc API is added. MIT execution source, recipe
and license are installed under `share/linux-wasm-cooperative-poll`; base SDK
build materials retain their selected-source scope.

The compiler mechanism is documented in
[Clang SanitizerCoverage](https://clang.llvm.org/docs/SanitizerCoverage.html).
