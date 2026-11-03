# Linux clone exit notification

This static C fork-profile candidate sends standard clone_args.exit_signal
through native Linux clone3. Nondefault values require private execution-object
capability bit 6 and its fixed-i32 staging function. Every native request stages
its own value; the object consumes it once and resets SIGCHLD even on errors.
Older objects and non-native transport refuse nondefault requests before unwind.
This introduces no libc API or syscall number and keeps independent user memory
and the single-thread fork requirement.

Flags-first legacy clone also transports its CSIGNAL byte through syscall 220.
Nondefault values require capability bit 14 and the separate optional
`__wasm_fork_clone_exit_signal` execution export. Existing helpers retain their
signatures and SIGCHLD behavior. This path never translates to clone3, whose
validation differs. The low byte is removed before parsing flags, so bit 7 in
CSIGNAL cannot accidentally request CLONE_NEWTIME. Linux owns notifications,
wait classes and legacy handling of the whole byte, including values above 64.

`clone-exit-signal-check-both` requires each pointer width to complete these
three stages first with clone3, then with flags-first legacy clone:

1. Zero notification, PIDFD exit readiness and __WCLONE-only reaping.
2. One SIGUSR1 notification, no SIGCHLD, and ordinary wait exclusion.
3. Later SIGCHLD notification/ordinary reaping, invalid clone3 signal without
   PIDFD publication (clone3 only), no remaining children in any wait class,
   ordinary libc fork/wait recovery and fd cleanup.

Each target must publish a single final pass and finish the machine shutdown
gate. Native x86-64 references use legacy clone to validate notification/PIDFD/
wait semantics; they do not cover clone3's invalid-signal validation or the Wasm
continuation. The forced-SIGCHLD negative control must fail.

Original code is MIT licensed; build materials retain upstream licenses.
