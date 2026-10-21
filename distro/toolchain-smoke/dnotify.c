/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: dnotify: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
static void create_file(int directory, const char *name)
{
	int fd = openat(directory, name, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600);
	require(fd >= 0 && close(fd) == 0, "create watched file");
}
static void expect_event(const sigset_t *set, int signo, int fd)
{
	struct timespec timeout = {2, 0};
	siginfo_t info = {0};
	require(sigtimedwait(set, &info, &timeout) == signo && info.si_signo == signo &&
	        info.si_code == POLL_MSG && info.si_fd == fd && (info.si_band & POLLIN),
	        "queued signal, code, descriptor and band");
}
static void expect_empty(const sigset_t *set)
{
	struct timespec zero = {0};
	siginfo_t info;
	require(sigtimedwait(set, &info, &zero) == -1 && errno == EAGAIN, "no unexpected notification");
}
int main(void)
{
	if (mkdir("/tmp", 0700)) require(errno == EEXIST, "temporary directory");
	char path[] = "/tmp/dnotify-XXXXXX";
	require(mkdtemp(path) != NULL, "temporary directory creation");
	int directory = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	int signo = SIGRTMIN + 2;
	require(directory >= 0 && signo <= SIGRTMAX, "directory and real-time signal");
	sigset_t set, old;
	require(sigemptyset(&set) == 0 && sigaddset(&set, signo) == 0 && sigaddset(&set, SIGIO) == 0 &&
	        sigprocmask(SIG_BLOCK, &set, &old) == 0, "block notification signals");
	require(fcntl(directory, F_SETOWN, (long)getpid()) == 0 &&
	        fcntl(directory, F_SETSIG, (long)signo) == 0 &&
	        fcntl(directory, F_NOTIFY, (long)DN_CREATE) == 0, "one-shot registration");
	create_file(directory, "one");
	expect_event(&set, signo, directory);
	create_file(directory, "two");
	expect_empty(&set);
	puts("dnotify: one-shot directory signal, descriptor and automatic disarm pass");

	require(fcntl(directory, F_NOTIFY, (long)(DN_CREATE | DN_MULTISHOT)) == 0,
	        "multishot registration");
	create_file(directory, "three");
	expect_event(&set, signo, directory);
	create_file(directory, "four");
	expect_event(&set, signo, directory);
	require(fcntl(directory, F_NOTIFY, 0L) == 0 &&
	        fcntl(directory, F_NOTIFY, (long)(DN_DELETE | DN_MULTISHOT)) == 0,
	        "remove and replace event mask");
	create_file(directory, "five");
	expect_empty(&set);
	require(unlinkat(directory, "five", 0) == 0, "watched deletion");
	expect_event(&set, signo, directory);
	require(fcntl(directory, F_NOTIFY, 0L) == 0, "explicit watch removal");
	require(unlinkat(directory, "four", 0) == 0, "unwatched deletion");
	expect_empty(&set);
	puts("dnotify: multishot, event-mask replacement and explicit removal pass");

	int regular = openat(directory, "one", O_RDONLY);
	require(regular >= 0 && fcntl(regular, F_NOTIFY, (long)DN_CREATE) == -1 && errno == ENOTDIR &&
	        close(regular) == 0, "non-directory refusal");
	require(fcntl(-1, F_NOTIFY, (long)DN_CREATE) == -1 && errno == EBADF, "bad descriptor refusal");
	require(fcntl(directory, F_NOTIFY, (long)(DN_CREATE | DN_MULTISHOT)) == 0, "watch recovery");
	int writer = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	require(writer >= 0 && close(directory) == 0, "close watched descriptor");
	create_file(writer, "six");
	expect_empty(&set);
	require(unlinkat(writer, "one", 0) == 0 && unlinkat(writer, "two", 0) == 0 &&
	        unlinkat(writer, "three", 0) == 0 && unlinkat(writer, "six", 0) == 0 &&
	        close(writer) == 0 && rmdir(path) == 0 &&
	        sigprocmask(SIG_SETMASK, &old, NULL) == 0, "cleanup and restore signal mask");
	puts("dnotify: invalid descriptors, recovery, close removal and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
