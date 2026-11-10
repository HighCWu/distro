<!-- SPDX-License-Identifier: MIT -->

# Signal syscall context ABI consumer

This C consumer uses existing musl signal and thread entry points alongside the
internal `linux_signal_syscall_v1` Wasm execution ABI.

`abi()` returns 1 when both kernel operations are available. `frame(pointer)`
reads the current handler's immutable two-word snapshot. `finish(pointer)`
validates an update for application when that handler returns. Operations return
0 or a negative errno. Flags 1 and 2 represent a valid interrupted syscall and
an existing restart decision. A pending restart appears with result `-EINTR`.
Clearing flag 2 cancels it and applies the supplied result. Keeping flag 2
requires the original result. Cancellation is irreversible within that frame.

The runtime drives blocking `read` calls with an independent pthread and a
standard `sigaction` handler. It checks the two-word `{ long result; unsigned
long flags; }` frame, rejects invalid edits without changing live state,
cancels `SA_RESTART` with a custom errno, verifies a non-restarting frame,
and exercises a nested signal before allowing an unchanged restart to resume
the read. The handler performs no formatting or allocation. A process alarm
and the VM runner bound the workload.

The package exposes wasm32 and wasm64 VM checks. Each check requires the
runtime pass marker and runner shutdown.
