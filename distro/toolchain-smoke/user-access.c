// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <unistd.h>

static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: user-access: %s errno=%d\n", message, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
/* Raw standard syscalls keep the NULL arguments opaque to compiler builtin
 * assumptions about libc read/write's nonnull access annotations. */
static long call(long nr, long a, long b, long c, long d, long e, long f)
{
	return syscall(nr, a, b, c, d, e, f);
}

int main(void)
{
	int fds[2];
	char byte = 0;
	require(pipe2(fds, O_NONBLOCK | O_CLOEXEC) == 0, "create pipe");
	require(write(fds[1], "R", 1) == 1, "queue readable byte");
	errno = 0;
	require(call(SYS_read, fds[0], 0, 1, 0, 0, 0) == -1 && errno == EFAULT, "NULL read buffer");
	require(read(fds[0], &byte, 1) == 1 && byte == 'R', "failed read preserves queued byte");
	errno = 0;
	require(call(SYS_write, fds[1], 0, 1, 0, 0, 0) == -1 && errno == EFAULT, "NULL write buffer");
	errno = 0;
	require(read(fds[0], &byte, 1) == -1 && errno == EAGAIN, "failed write queues no bytes");
	require(call(SYS_read, fds[0], 0, 0, 0, 0, 0) == 0 &&
		call(SYS_write, fds[1], 0, 0, 0, 0, 0) == 0, "zero length permits NULL buffer");
	errno = 0;
	require(call(SYS_openat, AT_FDCWD, 0, O_RDONLY, 0, 0, 0) == -1 && errno == EFAULT, "NULL pathname");
	errno = 0;
	require(call(SYS_uname, 0, 0, 0, 0, 0, 0) == -1 && errno == EFAULT, "NULL structure output");
	int word = 0;
	/* Linux UAPI: FUTEX_WAKE_OP_PRIVATE and ADD 1 / compare equal 0. This
	 * non-waiting command uses the ordinary futex number at both widths. */
	errno = 0;
	require(call(SYS_futex, (long)&word, 5 | 128, 0, 0, 0, (1L << 28) | (1L << 12)) == -1 &&
		errno == EFAULT && word == 0, "NULL futex atomic target");
	puts("user-access: NULL data, pathname, structure and atomic targets reject without side effects pass");
	struct utsname name;
	require(uname(&name) == 0 && strcmp(name.sysname, "Linux") == 0, "valid structure retry");
	require(write(fds[1], "S", 1) == 1 && read(fds[0], &byte, 1) == 1 && byte == 'S', "valid pipe retry");
	require(close(fds[0]) == 0 && close(fds[1]) == 0, "close pipe");
	puts("user-access: zero lengths, valid retries and descriptor recovery pass");
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
