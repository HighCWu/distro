// SPDX-License-Identifier: MIT
// This translation unit deliberately bypasses both fork() and libc syscall().
// Its syscall register layout is Linux/Wasm's, not x86 or another Linux arch.
#include <signal.h>
#include <sys/syscall.h>

#ifdef __wasm__
__attribute__((import_module("linux"), import_name("syscall")))
#endif
extern long raw_linux_syscall(long, long, long, long, long, long, long);

static volatile int raw_global = 61;

int raw_clone_refusal_probe(void)
{
	return raw_linux_syscall(SYS_clone, 0, 0, SIGCHLD, 0, 0, 0) == -95 &&
		raw_linux_syscall(SYS_clone, 0, 9, SIGCHLD, 0, 0, 0) == -22 &&
		raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0) > 0;
}

int raw_clone_continuation_probe(void)
{
	long parent = raw_linux_syscall(SYS_getpid, 0, 0, 0, 0, 0, 0);
	// Unsupported variants fail before creating a process or changing frames.
	if (raw_linux_syscall(SYS_clone, 0, 9, SIGCHLD, 0, 0, 0) != -22 ||
		raw_linux_syscall(SYS_clone, 0, 0, 0, 0, 0, 0) != -95) return 0;
	for (int attempt = 0; attempt < 2; attempt++) {
		volatile int local = 43 + attempt;
		long child = raw_linux_syscall(SYS_clone, 0, 0, SIGCHLD, 0, 0, 0);
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
