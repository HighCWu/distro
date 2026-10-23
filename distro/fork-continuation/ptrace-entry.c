/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile unsigned long entry_started;
static pid_t tracee, newborn;

static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: ptrace-entry: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	/* Only the positive identities returned for this fixture's children. */
	if (newborn > 0) kill(newborn, SIGKILL);
	if (tracee > 0) kill(tracee, SIGKILL);
	while (waitpid(-1, NULL, __WALL) > 0 || errno == EINTR) {}
	exit(1);
#endif
}
static void require(int ok, const char *what)
{
	if (!ok) fail(what);
}
static long request(int operation, pid_t child, unsigned long address, unsigned long data)
{
	return ptrace(operation, child, (void *)address, (void *)data);
}
static int wait_for(pid_t child)
{
	int status;
	pid_t waited;
	do waited = waitpid(child, &status, __WALL); while (waited < 0 && errno == EINTR);
	require(waited == child, "wait for exact tracee");
	return status;
}
static int first_user_operation(void *argument)
{
	(void)argument;
	/* No syscall before this store: a stop at a later syscall is too late. */
	entry_started = 1;
	_exit(126);
}
static _Noreturn void run_tracee(void)
{
	if (request(PTRACE_TRACEME, 0, 0, 0) ||
	    syscall(SYS_tkill, (long)getpid(), (long)SIGSTOP, 0L, 0L, 0L, 0L)) _exit(111);
	void *stack = malloc(128 * 1024);
	if (!stack) _exit(112);
	/* Existing callback clone, no CLONE_THREAD and no private fork while
	 * another task shares the mm. The marker is shared only by these two. */
	pid_t child = clone(first_user_operation, (char *)stack + 128 * 1024,
	                    CLONE_VM | SIGCHLD, NULL);
	if (child <= 0) _exit(113);
	int status;
	pid_t waited;
	do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
	if (waited != child || !WIFSIGNALED(status) || WTERMSIG(status) != SIGTERM || entry_started) {
		printf("ptrace-entry: parent waited=%ld expected=%ld status=%x marker=%lu errno=%d\n",
		       (long)waited, (long)child, status, entry_started, errno);
		fflush(stdout);
		_exit(114);
	}
	free(stack);
	_exit(42);
}
int main(void)
{
	tracee = fork();
	require(tracee >= 0, "create tracee");
	if (!tracee) run_tracee();
	int status = wait_for(tracee);
	require(WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP, "initial TRACEME stop");
	require(request(PTRACE_SETOPTIONS, tracee, 0, PTRACE_O_TRACEFORK) == 0 &&
	        request(PTRACE_CONT, tracee, 0, 0) == 0, "enable fork event and resume tracee");
	status = wait_for(tracee);
	require(WIFSTOPPED(status) && WSTOPSIG(status) == SIGTRAP &&
	        (unsigned)status >> 16 == PTRACE_EVENT_FORK, "callback clone reports fork event");
	unsigned long child = 0;
	require(request(PTRACE_GETEVENTMSG, tracee, 0, (unsigned long)&child) == 0 &&
	        child > 0 && (unsigned long)(pid_t)child == child && (pid_t)child != tracee,
	        "obtain exact newborn identity");
	newborn = (pid_t)child;
	status = wait_for(newborn);
	require(WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP,
	        "newborn stops before first application operation");
	errno = 0;
	long marker = request(PTRACE_PEEKDATA, tracee, (unsigned long)&entry_started, 0);
	require(marker == 0 && errno == 0, "first application store has not happened");
	puts("ptrace-entry: fork event and newborn stop precede first application store pass");
	require(request(PTRACE_CONT, newborn, 0, SIGTERM) == 0, "terminate at initial stop");
	status = wait_for(newborn);
	require(WIFSIGNALED(status) && WTERMSIG(status) == SIGTERM,
	        "pending fatal signal wins before callback entry");
	newborn = 0;
	require(request(PTRACE_CONT, tracee, 0, 0) == 0, "resume real parent for reap");
	for (int stops = 0;; stops++) {
		status = wait_for(tracee);
		if (!WIFSTOPPED(status)) break;
		require(stops < 8 && WSTOPSIG(status) == SIGCHLD &&
		        request(PTRACE_CONT, tracee, 0, SIGCHLD) == 0,
		        "forward traced SIGCHLD to real parent");
	}
	require(WIFEXITED(status) && WEXITSTATUS(status) == 42,
	        "real parent observes untouched shared marker and signal exit");
	tracee = 0;
	puts("ptrace-entry: fatal signal before entry, untouched marker and real parent reap pass");
	pid_t recovery = fork();
	require(recovery >= 0, "fork recovery");
	if (!recovery) _exit(43);
	status = wait_for(recovery);
	require(WIFEXITED(status) && WEXITSTATUS(status) == 43 &&
	        waitpid(recovery, &status, WNOHANG) == -1 && errno == ECHILD,
	        "ordinary fork recovers and is reaped once");
	puts("ptrace-entry: ordinary fork recovery and single reap pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
