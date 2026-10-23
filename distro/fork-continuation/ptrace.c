/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile unsigned long word = ULONG_MAX;
static pid_t active_child;
static unsigned long replacement(void)
{
	return sizeof(long) == 8 ? (unsigned long)UINT64_C(0x1234567887654321) : 0x87654321UL;
}
static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: ptrace: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	if (active_child > 0) {
		int status;
		pid_t waited = waitpid(active_child, &status, WNOHANG);
		if (!waited || (waited == active_child && WIFSTOPPED(status))) {
			kill(active_child, SIGKILL);
			while (waitpid(active_child, NULL, 0) == -1 && errno == EINTR) {}
		}
	}
	exit(1);
#endif
}
static long request(int req, pid_t pid, uintptr_t addr, uintptr_t data)
{
	return ptrace(req, pid, (void *)addr, (void *)data);
}
static uint64_t bit(int sig)
{
	return UINT64_C(1) << (sig - 1);
}
static pid_t trace_child(int exit_code)
{
	pid_t child = fork();
	require(child >= 0, "create traceable child");
	if (!child) {
		sigset_t blocked, observed;
		if (sigemptyset(&blocked) || sigaddset(&blocked, SIGUSR1) ||
		    sigprocmask(SIG_SETMASK, &blocked, NULL) ||
		    request(PTRACE_TRACEME, 0, 0, 0) || raise(SIGSTOP)) _exit(111);
		if (word != replacement() || sigprocmask(SIG_SETMASK, NULL, &observed) ||
		    sigismember(&observed, SIGUSR1) != 0 || sigismember(&observed, SIGUSR2) != 1 ||
		    sigismember(&observed, SIGKILL) != 0 || sigismember(&observed, SIGSTOP) != 0)
			_exit(112);
		_exit(exit_code);
	}
	int status;
	active_child = child;
	require(waitpid(child, &status, 0) == child && WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP,
	        "TRACEME signal-delivery stop reported to parent");
	return child;
}
static void patch_child(pid_t child)
{
	uint64_t mask = bit(SIGUSR2) | bit(SIGKILL) | bit(SIGSTOP), observed = 0;
	require(request(PTRACE_POKEDATA, child, (uintptr_t)&word, replacement()) == 0,
	        "write remote machine word");
	require(request(PTRACE_SETSIGMASK, child, sizeof mask, (uintptr_t)&mask) == 0 &&
	        request(PTRACE_GETSIGMASK, child, sizeof observed, (uintptr_t)&observed) == 0 &&
	        observed == bit(SIGUSR2), "set child mask while preserving KILL/STOP protection");
	errno = 0;
	unsigned long value = (unsigned long)request(PTRACE_PEEKDATA, child, (uintptr_t)&word, 0);
	require(value == replacement() && !errno && word == ULONG_MAX,
	        "read back full-width remote data without modifying parent's independent memory");
}
static void reap(pid_t child, int exit_code)
{
	int status;
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == exit_code,
	        "resumed child observed patched word and mask");
	active_child = 0;
	require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single child reap");
}
int main(void)
{
	sigset_t original, after;
	require(sigprocmask(SIG_SETMASK, NULL, &original) == 0, "save parent signal mask");
	pid_t child = trace_child(37);
	siginfo_t info = {0};
	unsigned long event = ULONG_MAX;
	uint64_t mask = 0;
	require(request(PTRACE_GETSIGINFO, child, 0, (uintptr_t)&info) == 0 &&
	        info.si_signo == SIGSTOP && info.si_pid == child && info.si_code == SI_TKILL,
	        "generic signal information and sender identity");
	require(request(PTRACE_GETEVENTMSG, child, 0, (uintptr_t)&event) == 0 && !event &&
	        request(PTRACE_GETSIGMASK, child, sizeof mask, (uintptr_t)&mask) == 0 &&
	        mask == bit(SIGUSR1), "generic event and original blocked mask");
	errno = 0;
	require((unsigned long)request(PTRACE_PEEKDATA, child, (uintptr_t)&word, 0) == ULONG_MAX && !errno,
	        "all-ones peek is data, not an errno failure");
	require(request(PTRACE_GETSIGMASK, child, sizeof mask - 1, (uintptr_t)&mask) == -1 && errno == EINVAL &&
	        request(PTRACE_GETSIGMASK, child, sizeof mask, (uintptr_t)-4096) == -1 && errno == EFAULT,
	        "invalid mask length and output rejected");
	require(request(PTRACE_PEEKDATA, child, (uintptr_t)-1, 0) == -1 && errno == EIO &&
	        request(0x7fffffff, child, 0, 0) == -1 && errno == EIO,
	        "invalid remote address and unknown request return errors, not kernel traps");
	patch_child(child);
	puts("ptrace: TRACEME stop, signal metadata, full-width remote words and mask control pass");
	require(request(PTRACE_CONT, child, 0, 0) == 0, "generic continue");
	reap(child, 37);
	puts("ptrace: continued child observes edits, parent memory isolation and single reap pass");

	child = trace_child(38);
	patch_child(child);
	require(request(PTRACE_DETACH, child, 0, 0) == 0, "detach without architecture debug-state trap");
	reap(child, 38);
	child = fork();
	require(child >= 0, "ordinary fork after detach");
	if (!child) _exit(39);
	active_child = child;
	reap(child, 39);
	require(sigprocmask(SIG_SETMASK, NULL, &after) == 0 && word == ULONG_MAX,
	        "parent state remains available");
	for (int sig = 1; sig < 32; ++sig)
		require(sigismember(&after, sig) == sigismember(&original, sig), "parent mask isolation");
	puts("ptrace: detach, ordinary fork recovery, parent masks and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
}
