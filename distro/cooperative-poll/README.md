<!-- SPDX-License-Identifier: MIT -->

# Cooperative user execution: compiler component

This is an experimental execution component. It is not connected to the
released SDK or Linux/Worker entry path yet.

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

Before publishing a profile, connect a kernel interrupt-return checkpoint and
Worker execution guards, then verify timers, targeted pthread signals,
siglongjmp, strict seccomp, and machine shutdown inside actual Linux. Preserve
syscall tracing/policy boundaries and defer unsafe live kernel callbacks.
Coverage of existing uninstrumented libraries and compatibility with programs
providing their own coverage hooks need separate treatment. Default builds,
libc APIs, and the supported fork scope remain unchanged.

The compiler mechanism is documented in
[Clang SanitizerCoverage](https://clang.llvm.org/docs/SanitizerCoverage.html).
