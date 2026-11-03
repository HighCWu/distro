// SPDX-License-Identifier: MIT
// Opt-in execution ABI only. Process creation uses the existing Linux clone.
#include <stdint.h>
#include <errno.h>
#include <signal.h>
#include <sys/syscall.h>

#ifdef WASM_FORK_USER_POLL
__attribute__((export_name("__wasm_fork_user_poll_abi")))
int __wasm_fork_user_poll_abi(void) { return 1; }
#endif

__attribute__((import_module("linux"), import_name("syscall")))
extern long fork_callback_syscall(long, long, long, long, long, long, long);

static unsigned char saved_frames[256 * 1024] __attribute__((aligned(16)));
static struct {
	uintptr_t cursor;
	uintptr_t end;
} descriptor;

/* Architecture execution support, also usable by non-libc syscall callers.
 * The loader requests a fresh descriptor only before starting a new unwind. */
__attribute__((export_name("__wasm_fork_syscall_abi")))
int __wasm_fork_syscall_abi(void)
{
	/* Old loaders accept only 1 and must refuse this object before _start.
	 * Version 2 requires the bounded clone3 adapter, not raw kernel clone3. */
	return 2;
}

__attribute__((export_name("__wasm_fork_descriptor")))
uintptr_t __wasm_fork_descriptor(void)
{
	descriptor.cursor = (uintptr_t)saved_frames;
	descriptor.end = (uintptr_t)(saved_frames + sizeof saved_frames);
	return (uintptr_t)&descriptor;
}

/* The loader recognizes this callback and resumes _start's saved continuation.
 * Never execute an ordinary C callback using a copied, active parent C stack. */
static int fork_child(void *unused)
{
	(void)unused;
	__builtin_trap();
}

__attribute__((export_name("__wasm_fork_abi")))
int __wasm_fork_abi(void)
{
	return 1;
}

__attribute__((export_name("__wasm_fork_child_entry")))
uintptr_t __wasm_fork_child_entry(void)
{
	return (uintptr_t)fork_child;
}

__attribute__((export_name("__wasm_fork_clone")))
long __wasm_fork_clone(void)
{
	return fork_callback_syscall(SYS_clone, (long)fork_child, 0, SIGCHLD, 0, 0, 0);
}

/* Optional execution helper, not a libc function. Linux's callback clone
 * already accepts CLONE_PIDFD (0x1000) using its parent_tid register. */
__attribute__((export_name("__wasm_fork_clone_pidfd")))
long __wasm_fork_clone_pidfd(uintptr_t pidfd)
{
	return fork_callback_syscall(SYS_clone, (long)fork_child, 0,
		SIGCHLD | 0x1000, (long)pidfd, 0, 0);
}

/* Optional execution transport, not a libc entry point. The kernel owns all
 * namespace permissions and creation/rollback. NEWTIME cannot be carried in
 * legacy clone's CSIGNAL word and is deliberately excluded. */
__attribute__((export_name("__wasm_fork_clone_namespaces")))
long __wasm_fork_clone_namespaces(uintptr_t namespaces, uintptr_t pidfd)
{
	const uintptr_t allowed = UINT32_C(0x7e020000);
	if (!namespaces || (namespaces & ~allowed))
		return -EOPNOTSUPP;
	return fork_callback_syscall(SYS_clone, (long)fork_child, 0,
		(long)namespaces | SIGCHLD | (pidfd ? 0x1000 : 0), (long)pidfd, 0, 0);
}

/* Legacy clone retains syscall 220 and its aliased parent_tid/PIDFD slot.
 * Linux handles stores, namespace identity, permissions and alias rejection. */
__attribute__((export_name("__wasm_fork_clone_options")))
long __wasm_fork_clone_options(uintptr_t flags, uintptr_t parent, uintptr_t child)
{
	const uintptr_t allowed = UINT32_C(0xffb69600);
	if (flags & ~allowed)
		return -EOPNOTSUPP;
	return fork_callback_syscall(SYS_clone, (long)fork_child, 0,
		(long)flags | SIGCHLD, (long)parent, (long)child, 0);
}

/* Private execution transport into Linux's original clone3 implementation.
 * Keep the canonical structure outside active Asyncify frames. The loader
 * has already suspended this single-thread caller; Linux alone writes TIDs
 * and allocates/publishes PIDFDs. No libc or application API is added. */
static int32_t selected_tids[32];
static unsigned clone3_exit_signal = SIGCHLD;

__attribute__((export_name("__wasm_fork_clone3_exit_signal")))
int __wasm_fork_clone3_exit_signal(int signal)
{
	if (signal < 0 || signal > 64) return -EINVAL;
	clone3_exit_signal = signal;
	return 0;
}

static long clone3_native(uint64_t flags, uintptr_t pidfd,
	uintptr_t parent_tid, uintptr_t child_tid, uint64_t cgroup, unsigned count)
{
	unsigned signal = clone3_exit_signal;
	clone3_exit_signal = SIGCHLD;
	static struct {
		uint64_t flags, pidfd, child_tid, parent_tid, exit_signal;
		uint64_t stack, stack_size, tls, set_tid, set_tid_size, cgroup;
	} args __attribute__((aligned(8)));
	_Static_assert(sizeof args == 88, "Linux clone_args aligned u64 ABI");
	const uint64_t allowed = UINT64_C(0x3fffb68680);
	if (flags & ~allowed)
		return -EOPNOTSUPP;
	if (count > 32)
		return -EINVAL;
	args.flags = flags | (pidfd ? 0x1000 : 0);
	args.pidfd = pidfd;
	args.child_tid = child_tid;
	args.parent_tid = parent_tid;
	args.exit_signal = signal;
	args.cgroup = cgroup;
	args.set_tid = count ? (uintptr_t)selected_tids : 0;
	args.set_tid_size = count;
	return fork_callback_syscall(SYS_clone3, (long)&args, sizeof args, 0, 0, 0, 0);
}

/* Preserve the old pointer-width helper's signature for existing loaders. */
__attribute__((export_name("__wasm_fork_clone3_native")))
long __wasm_fork_clone3_native(uintptr_t flags, uintptr_t pidfd,
	uintptr_t parent_tid, uintptr_t child_tid)
{
	if (flags & ~(uintptr_t)UINT32_C(0xffb68600))
		return -EOPNOTSUPP;
	return clone3_native(flags, pidfd, parent_tid, child_tid, 0, 0);
}

/* Flags are i64 on both architectures, independent of pointer width. */
__attribute__((export_name("__wasm_fork_clone3_flags64")))
long __wasm_fork_clone3_flags64(uint64_t flags, uintptr_t pidfd,
	uintptr_t parent_tid, uintptr_t child_tid)
{
	/* Keep the old signature and never silently supply fd 0 for a new flag. */
	if (flags & UINT64_C(0x200000000))
		return -EOPNOTSUPP;
	return clone3_native(flags, pidfd, parent_tid, child_tid, 0, 0);
}

__attribute__((export_name("__wasm_fork_clone3_cgroup")))
long __wasm_fork_clone3_cgroup(uint64_t flags, uintptr_t pidfd,
	uintptr_t parent_tid, uintptr_t child_tid, uint64_t cgroup)
{
	return clone3_native(flags, pidfd, parent_tid, child_tid, cgroup, 0);
}

__attribute__((export_name("__wasm_fork_clone3_set_tid")))
int __wasm_fork_clone3_set_tid(unsigned index, int32_t value)
{
	if (index >= 32)
		return -EINVAL;
	selected_tids[index] = value;
	return 0;
}

__attribute__((export_name("__wasm_fork_clone3_pid_select")))
long __wasm_fork_clone3_pid_select(uint64_t flags, uintptr_t pidfd,
	uintptr_t parent_tid, uintptr_t child_tid, uint64_t cgroup, unsigned count)
{
	if (!count)
		return -EINVAL;
	return clone3_native(flags, pidfd, parent_tid, child_tid, cgroup, count);
}

/* Private object capability, not a libc/application API. Bit 0 admits
 * CLONE_NEWTIME; bit 1 cgroup; bit 2 set_tid; bit 3 CLONE_FS/FILES;
 * bit 4 CLONE_SYSVSEM; bit 5 native CLONE_NNP; bit 6 exit_signal staging;
 * bit 7 CLONE_AUTOREAP; bit 8 CLONE_PIDFD_AUTOKILL; bit 9 CLONE_PARENT;
 * bit 10 CLONE_EMPTY_MNTNS; bit 11 CLONE_IO; bit 12 CLONE_UNTRACED. */
__attribute__((export_name("__wasm_fork_clone3_features")))
int __wasm_fork_clone3_features(void)
{
	return 8191;
}
