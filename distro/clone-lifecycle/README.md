# Native clone3 process lifetime

This independent static C fork-profile candidate forwards CLONE_AUTOREAP and
CLONE_PIDFD_AUTOKILL to the existing Linux implementation. Each requires its
own private object capability (bits 7 and 8). Zero exit signal and CLONE_NNP
retain their independent gates. Linux validates incompatible combinations and
owns task release and SIGKILL; the host does not emulate these actions.

`clone-lifecycle-check-both` requires each width to complete four stages:

1. A zero-signal control child remains a zombie until __WCLONE wait reaps it.
2. AUTOREAP releases a child without wait; PIDFD reports HUP, all wait classes
   return ECHILD, and pidfd_send_signal no longer addresses the released task.
3. A duplicated owning PIDFD keeps the paused NNP child alive after the first
   close. Last close terminates it. A separately opened observing PIDFD carries
   no autokill flag and confirms task release without retaining the owning file.
4. Invalid signal/flag/PIDFD combinations publish neither child nor PIDFD, and
   later ordinary fork remains waitable with SIGCHLD.

Every target needs one final pass and machine shutdown. Local compiler/engine
checks verify transport and refusal, not kernel lifetime semantics. The native
reference workloads cover earlier SEM_UNDO/exit-notification behavior only.

No libc interface, syscall number, shared mapping or multithreaded fork support
is added. Original code is MIT; build materials retain upstream licenses.
