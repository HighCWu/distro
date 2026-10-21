// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/resource.h>
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
struct clone_pidfd_request {
	uint64_t flags, pidfd, child_tid, parent_tid, exit_signal, stack, stack_size, tls;
	uint64_t set_tid, set_tid_size, cgroup;
};
_Static_assert(sizeof(struct clone_pidfd_request) == 88, "clone_args u64 layout");
_Static_assert(offsetof(struct clone_pidfd_request, exit_signal) == 32, "clone_args signal offset");

static long clone_with_pidfd(struct clone_pidfd_request *request)
{
	return syscall(SYS_clone3, (long)request, (long)sizeof *request, 0L, 0L, 0L, 0L);
}

static void check_clone_pidfd(void)
{
	volatile int output = -7;
	struct clone_pidfd_request request = {
		.flags = CLONE_PIDFD, .pidfd = (uintptr_t)&output, .exit_signal = SIGCHLD,
	};
	request.pidfd = 0;
	errno = 0;
	require(clone_with_pidfd(&request) == -1 && errno == EFAULT, "clone3 null pidfd output");
	request.pidfd = UINT64_MAX - 7;
	errno = 0;
	require(clone_with_pidfd(&request) == -1 && errno == EFAULT, "clone3 full-width bad pidfd output");
	request.pidfd = (uintptr_t)&output;
	struct rlimit original, limited;
	require(getrlimit(RLIMIT_NOFILE, &original) == 0 && original.rlim_cur >= 32, "query fd limit for clone3");
	limited = original;
	limited.rlim_cur = 32;
	require(setrlimit(RLIMIT_NOFILE, &limited) == 0, "limit clone3 descriptor allocation");
	int anchor = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	require(anchor >= 0, "clone3 fd anchor");
	int filled[32], count = 0;
	for (;;) {
		int next = fcntl(anchor, F_DUPFD_CLOEXEC, 0);
		if (next < 0) {
			require(errno == EMFILE, "fill fd table before clone3");
			break;
		}
		require(count < 32, "bounded fd fill");
		filled[count++] = next;
	}
	for (int i = 0; i < 3; i++) {
		errno = 0;
		require(clone_with_pidfd(&request) == -1 && errno == EMFILE && output == -7,
			"clone3 pidfd allocation failure rolls back");
		int status;
		errno = 0;
		require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD,
			"failed clone3 leaves no reapable child");
	}
	while (count) require(close(filled[--count]) == 0, "release filled descriptor");
	require(close(anchor) == 0 && setrlimit(RLIMIT_NOFILE, &original) == 0, "restore fd capacity");
	int ready[2], hold[2], status;
	char byte;
	require(!pipe(ready) && !pipe(hold), "clone3 synchronization pipes");
	pid_t child = clone_with_pidfd(&request);
	require(child >= 0, "clone3 with atomic pidfd");
	if (!child) {
		close(ready[0]); close(hold[1]);
		int parent_fd;
		if (read(hold[0], &parent_fd, sizeof parent_fd) != sizeof parent_fd) _exit(94);
		errno = 0;
		if (output != -7 || fcntl(parent_fd, F_GETFD) != -1 || errno != EBADF ||
			write(ready[1], "R", 1) != 1) _exit(94);
		close(ready[1]);
		_exit(read(hold[0], &byte, 1) < 0 ? 95 : 96);
	}
	close(ready[1]); close(hold[0]);
	int fd = output;
	require(fd >= 0 && (fcntl(fd, F_GETFD) & FD_CLOEXEC), "clone3 pidfd close-on-exec");
	require(write(hold[1], &fd, sizeof fd) == sizeof fd, "publish parent pidfd number to child");
	require(read(ready[0], &byte, 1) == 1 && byte == 'R', "clone3 child output isolation and readiness");
	close(ready[0]);
	require(signal_pid(fd, 0, 0) == 0 && signal_pid(fd, SIGTERM, 0) == 0, "signal atomic pidfd");
	struct pollfd pollfd = {.fd = fd, .events = POLLIN};
	require(poll(&pollfd, 1, 5000) == 1 && (pollfd.revents & POLLIN), "atomic pidfd exit readiness");
	siginfo_t info;
	memset(&info, 0, sizeof info);
	require(waitid(P_PIDFD, (id_t)fd, &info, WEXITED | WNOWAIT) == 0 &&
		info.si_pid == child && info.si_code == CLD_KILLED && info.si_status == SIGTERM,
		"atomic pidfd identifies clone3 child");
	require(waitpid(child, &status, 0) == child && WIFSIGNALED(status) &&
		WTERMSIG(status) == SIGTERM, "reap clone3 child");
	errno = 0;
	require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "clone3 child reaped once");
	require(close(fd) == 0 && close(hold[1]) == 0, "close atomic pidfd resources");
	puts("process-control: clone3 CLONE_PIDFD, allocation rollback, child isolation and atomic identity pass");
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
	require(signal_pid(fd, SIGSTOP, 0) == 0, "stop child through pidfd");
	for (int i = 0; i < 2; i++) {
		siginfo_t stopped;
		memset(&stopped, 0, sizeof(stopped));
		require(waitid(P_PIDFD, (id_t)fd, &stopped, WSTOPPED | WNOWAIT) == 0,
			"observe stopped child without consuming state");
		require(stopped.si_pid == child && stopped.si_code == CLD_STOPPED && stopped.si_status == SIGSTOP,
			"stopped identity and signal status");
	}
	require(waitpid(child, &status, WUNTRACED) == child && WIFSTOPPED(status) &&
		WSTOPSIG(status) == SIGSTOP, "consume stopped status once");
	siginfo_t unchanged;
	memset(&unchanged, 0x5a, sizeof(unchanged));
	require(waitid(P_PIDFD, (id_t)fd, &unchanged, WSTOPPED | WNOHANG) == 0 &&
		unchanged.si_pid == 0, "consumed stop has no pending status");
	require(poll(&p, 1, 0) == 0 && signal_pid(fd, 0, 0) == 0,
		"stopped child remains alive and is not exit-ready");
	puts("process-control: SIGSTOP, WSTOPPED WNOWAIT and single stop consumption pass");
	require(signal_pid(fd, SIGCONT, 0) == 0, "continue child through pidfd");
	for (int i = 0; i < 2; i++) {
		siginfo_t continued;
		memset(&continued, 0, sizeof(continued));
		require(waitid(P_PIDFD, (id_t)fd, &continued, WCONTINUED | WNOWAIT) == 0,
			"observe continued child without consuming state");
		require(continued.si_pid == child && continued.si_code == CLD_CONTINUED && continued.si_status == SIGCONT,
			"continued identity and signal status");
	}
	require(waitpid(child, &status, WCONTINUED) == child && WIFCONTINUED(status),
		"consume continued status once");
	memset(&unchanged, 0x5a, sizeof(unchanged));
	require(waitid(P_PIDFD, (id_t)fd, &unchanged, WCONTINUED | WNOHANG) == 0 &&
		unchanged.si_pid == 0, "consumed continuation has no pending status");
	require(poll(&p, 1, 0) == 0 && signal_pid(fd, 0, 0) == 0,
		"continued child remains alive and is not exit-ready");
	puts("process-control: SIGCONT, WCONTINUED WNOWAIT and single continuation consumption pass");
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
	check_clone_pidfd();
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
