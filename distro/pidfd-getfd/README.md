<!-- SPDX-License-Identifier: MIT -->
# Standard cross-process descriptor transfer

This optional static C fork-profile workload uses the pinned Linux kernel's
existing pidfd_getfd syscall. It adds no libc wrapper, private application API,
kernel syscall number or multi-thread fork support. All raw syscall arguments
are explicit machine words, including six argument registers on both widths.

The child creates a regular file after fork, so the parent cannot inherit its
open description. Parent and child coordinate exclusively through ordinary
pipes. The first three stages require:

1. A copied CLOEXEC descriptor with independent descriptor flags, shared file
   offset and shared O_APPEND status; each process observes the other's work.
2. EINVAL/EBADF for bad flags and handles, no leaked descriptor slots, and a
   successful later copy of the same live open description.
3. Remote EBADF after source close, ESRCH after reaping, copied data still
   readable after unlink/source exit, all descriptors closed and normal fork
   recovery with no unreaped children.

Two further stages use ordinary Unix datagram sockets, sendmsg and recvmsg:

4. A file created after fork is queued as SCM_RIGHTS. The receiver requests
   SO_PASSCRED and MSG_CMSG_CLOEXEC. The sender closes/unlinks/exits before
   reception; the copied file and actual sender PID/UID/GID must survive.
5. Two rights are sent with room for only one descriptor at reception. Require
   exactly one CLOEXEC fd, MSG_CTRUNC, retained file offset/data, and no leaked
   receiver fd slots after closing that fd. Kernel-global file references and
   cyclic Unix socket garbage collection are not claimed by the slot check.

`pidfd-getfd-check-both` requires the full five stages and one final pass on
each width, followed by the existing machine-close gate. Native references use
an explicitly supplied temporary path. If host policy prevents the real syscall,
they exit 77 without a pass marker; that is not target or native acceptance.
On an allowing host, local dup instead of remote copy, removing CMSG CLOEXEC,
or enlarging the intentionally short control buffer must each fail. The libc's
inherited CMSG_NXTHDR macro has a signedness warning; only that consumer
expression locally suppresses it, leaving the generic libc macro unchanged.
Other credentials/namespace policies, pidfd flags and browsers need separate
evidence. These cases retain the existing single-thread fork restriction.
