// SPDX-License-Identifier: MIT
// This translation unit deliberately bypasses both fork() and libc syscall().
// v2 clone uses Linux's default flags, stack, ptid, ctid, tls layout.
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/syscall.h>

#ifdef __wasm__
__attribute__((import_module("linux"), import_name("syscall_v2")))
#endif
extern long raw_linux_syscall(long, long, long, long, long, long, long);

#ifdef __wasm__
__attribute__((import_module("linux"), import_name("syscall")))
#endif
extern long raw_legacy_syscall(long, long, long, long, long, long, long);

struct clone3_request {
	uint64_t flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls;
	uint64_t set_tid, set_tid_size, cgroup, extension;
};
_Static_assert(offsetof(struct clone3_request, extension) == 88, "clone3 u64 layout");

static volatile int raw_global = 61;

int raw_clone_refusal_probe(void)
{
	struct clone3_request request = {.exit_signal = SIGCHLD};
	return raw_linux_syscall(SYS_clone, SIGCHLD, 0, 0, 0, 0, 0) == -95 &&
		raw_linux_syscall(SYS_clone, SIGCHLD, 9, 0, 0, 0, 0) == -95 &&
		raw_linux_syscall(SYS_clone3, (long)&request, 88, 0, 0, 0, 0) == -95 &&
		raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0) > 0;
}

int raw_clone3_continuation_probe(void)
{
	struct clone3_request request = {.exit_signal = SIGCHLD};
	if (raw_legacy_syscall(SYS_clone3, (long)&request, 88, 0, 0, 0, 0) != -38 ||
		raw_linux_syscall(SYS_clone3, (long)&request, 63, 0, 0, 0, 0) != -22 ||
		raw_linux_syscall(SYS_clone3, (long)&request, 65537, 0, 0, 0, 0) != -7 ||
		raw_linux_syscall(SYS_clone3, 0, 88, 0, 0, 0, 0) != -14 ||
		raw_linux_syscall(SYS_clone3, -8, 88, 0, 0, 0, 0) != -14) return 0;
	request.extension = 1;
	if (raw_linux_syscall(SYS_clone3, (long)&request, 96, 0, 0, 0, 0) != -7) return 0;
	request.extension = 0;
	request.flags = 0x100;
	if (raw_linux_syscall(SYS_clone3, (long)&request, 88, 0, 0, 0, 0) != -95) return 0;
	request.flags = 0;
	int rejected_status = 0;
	if (raw_linux_syscall(SYS_wait4, -1, (long)&rejected_status, 1, 0, 0, 0) != -10) return 0;
	long parent = raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0);
	const long sizes[] = {64, 80, 88, 96};
	for (unsigned attempt = 0; attempt < sizeof sizes / sizeof sizes[0]; attempt++) {
		volatile int local = 53 + attempt;
		// Linux ignores the registers after clone3's pointer and size.
		long child = raw_linux_syscall(SYS_clone3, (long)&request, sizes[attempt], 777, 0, 0, 0);
		if (child < 0) return 0;
		if (!child) {
			long pid = raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0);
			long ppid = raw_linux_syscall(SYS_getppid, 0, 0, 0, 0, 0, 0);
			int valid = pid > 0 && pid != parent && ppid == parent &&
				local == (int)(53 + attempt) && raw_global == 61;
			local = 99; raw_global = 101;
			raw_linux_syscall(SYS_exit_group, valid ? 42 : 119, 0, 0, 0, 0, 0);
			__builtin_trap();
		}
		int status = 0;
		if (raw_linux_syscall(SYS_wait4, child, (long)&status, 0, 0, 0, 0) != child ||
			status != (42 << 8) || local != (int)(53 + attempt) || raw_global != 61) return 0;
		if (raw_linux_syscall(SYS_wait4, child, (long)&status, 0, 0, 0, 0) != -10) return 0;
	}
	return 1;
}

int raw_clone_continuation_probe(void)
{
	long parent = raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0);
	// Unsupported variants fail before creating a process or changing frames.
	if (raw_linux_syscall(SYS_clone, SIGCHLD, 9, 0, 0, 0, 0) != -95 ||
		raw_linux_syscall(SYS_clone, 0, 0, SIGCHLD, 0, 0, 0) != -95 ||
		raw_linux_syscall(SYS_clone, 0, 0, 0, 0, 0, 0) != -95) return 0;
	for (int attempt = 0; attempt < 2; attempt++) {
		volatile int local = 43 + attempt;
		long child = raw_linux_syscall(SYS_clone, SIGCHLD, 0, 0, 0, 0, 0);
		if (child < 0) return 0;
		if (!child) {
			long pid = raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0);
			long ppid = raw_linux_syscall(SYS_getppid, 0, 0, 0, 0, 0, 0);
			int valid = pid > 0 && pid != parent && ppid == parent &&
				local == 43 + attempt && raw_global == 61;
			local = 99;
			raw_global = 101;
			raw_linux_syscall(SYS_exit_group, valid ? 42 : 119, 0, 0, 0, 0, 0);
			__builtin_trap();
		}
		int status = 0;
		long waited = raw_linux_syscall(SYS_wait4, child, (long)&status, 0, 0, 0, 0);
		if (waited != child || status != (42 << 8) || local != 43 + attempt ||
			raw_global != 61) return 0;
		if (raw_linux_syscall(SYS_wait4, child, (long)&status, 0, 0, 0, 0) != -10) return 0;
	}
	return 1;
}
