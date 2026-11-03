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
syscall tracing/policy boundary. It defers live kernel callbacks and signal
handlers and rejects mixing this profile with dynamic loading or continuation
fork. Older kernels without the entry reject exec. This does not promise
nested signal delivery in a handler's pure loop.

Only application compilation units use the coverage flag. Existing libc and
startup libraries remain uninstrumented: ordinary pthread startup initializes
its native TLS before entering instrumented application code. Do not rebuild
libc/startup code with this profile or insert instrumented callbacks before TLS
initialization. A nonzero TLS base alone is insufficient to establish ownership
during early clone startup. Raw custom clone startup needs separate review.

The `cooperative-poll-check-both` target verifies real Linux timer delivery in
pure computation, siglongjmp and later recovery, targeted pthread signals and
TLS isolation, and a strict-seccomp child with a pure loop and raw thread exit.
It must finish all four stages and machine shutdown before acceptance. Local
compiler/host models do not establish this target result.

Existing uninstrumented library loops, custom coverage hooks, C++ exception
interaction, dynamic loading, fork combinations and overhead need separate
treatment. The current candidate primarily covers static C and ordinary pthread
application entries. No public libc API is added. MIT execution source, recipe
and license are installed under `share/linux-wasm-cooperative-poll`; base SDK
build materials retain their selected-source scope.

The compiler mechanism is documented in
[Clang SanitizerCoverage](https://clang.llvm.org/docs/SanitizerCoverage.html).
