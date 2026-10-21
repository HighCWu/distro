// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

/* Test-local adapters, not a new application API. Always pass six machine
 * words to musl's variadic syscall entry, including on wasm64. */
static int open_pid(pid_t pid, unsigned flags)
{
	return syscall(SYS_pidfd_open, (long)pid, (long)flags, 0L, 0L, 0L, 0L);
}
static int signal_pid(int fd, int signal, unsigned flags)
{
	return syscall(SYS_pidfd_send_signal, (long)fd, (long)signal, 0L, (long)flags, 0L, 0L);
}
static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: process-control: %s errno=%d\n", message, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
int main(void)
{
	int ready[2], hold[2], status;
	char byte;
	require(!pipe(ready) && !pipe(hold), "create synchronization pipes");
	pid_t child = fork();
	require(child >= 0, "fork controlled child");
	if (!child) {
		close(ready[0]); close(hold[1]);
		if (write(ready[1], "R", 1) != 1) _exit(91);
		close(ready[1]);
		/* A normal kernel entry lets cooperative signal delivery run. */
		_exit(read(hold[0], &byte, 1) < 0 ? 93 : 92);
	}
	close(ready[1]); close(hold[0]);
	require(read(ready[0], &byte, 1) == 1 && byte == 'R', "child readiness");
	close(ready[0]);
	int fd = open_pid(child, 0);
	require(fd >= 0, "pidfd_open");
	int flags = fcntl(fd, F_GETFD);
	require(flags >= 0 && (flags & FD_CLOEXEC), "pidfd close-on-exec");
	struct pollfd p = {.fd = fd, .events = POLLIN};
	require(poll(&p, 1, 0) == 0, "live pidfd is not exit-ready");
	require(signal_pid(fd, 0, 0) == 0, "pidfd signal existence check");
	errno = 0;
	require(open_pid(child, 0x80000000U) == -1 && errno == EINVAL, "pidfd_open invalid flags");
	errno = 0;
	require(signal_pid(-1, 0, 0) == -1 && errno == EBADF, "pidfd signal invalid descriptor");
	errno = 0;
	require(signal_pid(fd, 0, 0x80000000U) == -1 && errno == EINVAL, "pidfd signal invalid flags");
	puts("process-control: pidfd identity, readiness, CLOEXEC and rejection pass");
	require(signal_pid(fd, SIGTERM, 0) == 0, "signal child through pidfd");
	require(poll(&p, 1, 5000) == 1 && (p.revents & POLLIN), "pidfd exit readiness");
	for (int i = 0; i < 2; i++) {
		siginfo_t info;
		memset(&info, 0, sizeof(info));
		require(waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOWAIT) == 0,
			"waitid pidfd without reaping");
		require(info.si_pid == child && info.si_code == CLD_KILLED && info.si_status == SIGTERM,
			"stable waitid pidfd identity and signal status");
	}
	require(waitpid(child, &status, 0) == child && WIFSIGNALED(status) &&
		WTERMSIG(status) == SIGTERM, "single terminal reap");
	errno = 0;
	siginfo_t info;
	require(waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOHANG) == -1 && errno == ECHILD,
		"pidfd cannot reap child twice");
	errno = 0;
	require(signal_pid(fd, 0, 0) == -1 && errno == ESRCH, "reaped pidfd returns ESRCH");
	require(close(fd) == 0 && close(hold[1]) == 0, "close control descriptors");
	puts("process-control: pidfd signal, poll, waitid WNOWAIT and single reap pass");
	child = fork();
	require(child >= 0, "fork after process control");
	if (!child) _exit(37);
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 37,
		"later fork and wait recovery");
	puts("process-control: later fork and wait recovery pass");
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
