<!-- SPDX-License-Identifier: MIT -->
# Standard pidfd_getfd consumer

This optional static C fork-profile workload uses the pinned Linux kernel's
existing pidfd_getfd syscall. It adds no libc wrapper, private application API,
kernel syscall number or multi-thread fork support. All raw syscall arguments
are explicit machine words, including six argument registers on both widths.

The child creates a regular file after fork, so the parent cannot inherit its
open description. Parent and child coordinate exclusively through ordinary
pipes. The three stages require:

1. A copied CLOEXEC descriptor with independent descriptor flags, shared file
   offset and shared O_APPEND status; each process observes the other's work.
2. EINVAL/EBADF for bad flags and handles, no leaked descriptor slots, and a
   successful later copy of the same live open description.
3. Remote EBADF after source close, ESRCH after reaping, copied data still
   readable after unlink/source exit, all descriptors closed and normal fork
   recovery with no unreaped children.

`pidfd-getfd-check-both` requires the full three stages and one final pass on
each width, followed by the existing machine-close gate. Native references use
an explicitly supplied temporary path. If host policy prevents the real syscall,
they exit 77 without a pass marker; that is not target or native acceptance.
On an allowing host, replacing the remote copy with local dup must fail.
Other credentials, namespaces, pidfd flags and browsers need separate evidence.
