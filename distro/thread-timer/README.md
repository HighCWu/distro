<!-- SPDX-License-Identifier: MIT -->

# Existing SIGEV_THREAD timer path

The same musl API now compiles its existing timer worker with Wasm SjLj,
including the setjmp activation and the longjmp used for callback cleanup.
Its existing TLS reset also reinitializes the separate linker-owned native
Wasm TLS block. Neither change adds a function or a public declaration.

The ordinary-SDK workload exercises a rejected clock after helper creation,
three one-shot callbacks (normal return, pthread_exit, then normal return),
fresh native TLS and TSD destruction each time, timer deletion and detached
worker disappearance, and later timer creation/recovery. It reads the existing
proc task list to bound worker cleanup. It does not depend on the optional
CHECKPOINT_RESTORE /proc/self/timers file and does not claim a complete timer
resource-leak audit from thread counts alone. No fork profile is selected.

`thread-timer-check-both` requires all three stages, one final pass and shutdown
at both widths, using both the ordinary SDK and independent libc-polling SDK.
It also includes the existing ordinary checkpoint workloads with this musl.
The independent tiny-module check runs the actual timer/TLS-reset bodies under
Clang22 with modeled delivery. Missing SjLj traps; missing native reset fails
the per-callback initial-value assertion. This is separate from real Linux
timer, pthread and signal-delivery acceptance, which requires the public CI.

The Wasm create path preserves the raw kernel error across helper semaphore
handshake, translating it only after cleanup. A failed sem_trywait can set
EAGAIN while the original timer request failed with EINVAL. The tiny-module
check runs the actual create/error-return code and rejects lost-errno behavior.
The target's transparent pthread_create link wrapper records its actual result
for failure diagnostics; it forwards the call unchanged and does not implement
timer behavior or change the expected EINVAL result.
