# CLONE_PARENT continuation transport

This independent static C fork-profile candidate forwards CLONE_PARENT to
existing Linux clone/clone3. Private capability bit 9 is required. Native clone3
uses exit_signal zero and retains that field's separate capability; legacy clone
keeps its existing callback transport with SIGCHLD. Linux sets real_parent and
the inherited notification, applies init/flag restrictions and implements wait.
The host does not modify parentage. User memory remains independent.

`clone-parent-check-both` requires three stages per pointer width: native clone3
and legacy clone each create the caller's sibling, then ordinary fork/recovery
and cleanup. The outer controller reaps the new process with ordinary wait while
the caller is still blocked on a release pipe; the caller must get ECHILD when
trying to wait its sibling. The new process checks its actual getppid. This avoids
mistaking orphan reparenting for CLONE_PARENT. Namespace init must be rejected
when it tries to create siblings. All children are reaped once and pipes closed.

Each target needs one final pass and machine shutdown. Native x86-64 references
cover legacy clone parentage only; compile/engine checks do not establish Wasm
or native clone3 execution. No libc API, syscall number or multithreaded fork
support is added. Original code is MIT; materials retain upstream licenses.
