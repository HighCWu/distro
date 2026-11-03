<!-- SPDX-License-Identifier: MIT -->

# Kernel-driven robust-list owner death

The earlier pthread mutex tests permit musl to process private robust mutexes
before normal thread exit. This workload instead registers the Linux UAPI list
directly and exits through the raw syscall, with no pthread cleanup walk. It
also kills an owner while a real futex waiter has entered sleep, so merely
changing the word without waking the queued waiter cannot pass.

The public clone callback uses CLONE_VM and SIGCHLD with a dedicated C stack,
created before the parent's waiter pthread. Its code uses raw syscalls and no
libc allocation, errno or native TLS. This exercises the existing callback ABI;
it does not expand continuation fork or custom clone/TLS support. Native Linux
reference execution uses the same workload with a test-local syscall adapter.

Three stages cover raw exit and queried registration identity, SIGKILL and a
queued waiter wake, then list_op_pending, a bad next link, an invalid registered
head and later valid recovery. The invalid head must not invent owner death;
invalid user pointers must not crash the kernel. Waiting uses the standard
proc task state, without depending on the unavailable wchan/KALLSYMS view.

The tiny checks use actual fixed futex UAPI declarations with modeled scalar
include files for the Wasm frontend. The target uses the full installed kernel
headers. GCC/Clang execute the real native kernel reference and reject a build
which omits registration. These checks are not Wasm kernel acceptance. Both
widths must complete all stages, a unique pass and machine shutdown in CI.
