# Native clone3 exit notification

This static C fork-profile candidate sends standard clone_args.exit_signal
through native Linux clone3. Nondefault values require private execution-object
capability bit 6 and its fixed-i32 staging function. Every native request stages
its own value; the object consumes it once and resets SIGCHLD even on errors.
Older objects and non-native transport refuse nondefault requests before unwind.
This introduces no libc API or syscall number and keeps independent user memory
and the single-thread fork requirement. Legacy clone admission is unchanged.

`clone-exit-signal-check-both` requires each pointer width to complete:

1. Zero notification, PIDFD exit readiness and __WCLONE-only reaping.
2. One SIGUSR1 notification, no SIGCHLD, and ordinary wait exclusion.
3. Later SIGCHLD notification/ordinary reaping, invalid clone3 signal without
   PIDFD publication, no remaining children in any wait class and fd cleanup.

Each target must publish a single final pass and finish the machine shutdown
gate. Native x86-64 references use legacy clone to validate notification/PIDFD/
wait semantics; they do not cover clone3's invalid-signal validation or the Wasm
continuation. The forced-SIGCHLD negative control must fail.

Original code is MIT licensed; build materials retain upstream licenses.
