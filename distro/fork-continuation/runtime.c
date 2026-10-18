// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int before, prepared, parents, children;
static _Thread_local int tls_value = 17;
static int global_value = 11;
static void prepare(void) { prepared++; }
static void parent(void) { parents++; }
static void child(void) { children++; }
static _Noreturn void fail(const char *message)
{
	printf("::vm-test::fail: fork: %s errno=%d\n", message, errno);
	fflush(stdout);
	for (;;) sched_yield();
}
static void require(int condition, const char *message) { if (!condition) fail(message); }

__attribute__((noinline)) static pid_t nested(int depth)
{
	volatile int sentinel = 41 + depth;
	pid_t result;
	if (depth) result = nested(depth - 1);
	else { before++; result = fork(); }
	require(sentinel == 41 + depth, "saved local was lost");
	return result;
}
static pid_t (*volatile indirect)(int) = nested;

static void *blocked_thread(void *opaque)
{
	char byte;
	int fd = *(int *)opaque;
	return read(fd, &byte, 1) == 1 ? NULL : (void *)(uintptr_t)1;
}

int main(void)
{
	int pipefd[2], status, fd;
	char buffer[3] = {0};
	pid_t original = getpid(), pid;
	volatile int local = 31;
	int *heap = malloc(sizeof(*heap));
	unsigned char *mapping = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	sigset_t mask, observed;
	require(heap && mapping != MAP_FAILED, "allocate");
	*heap = 21; mapping[0] = 51;
	require(!pipe(pipefd), "pipe");
#ifdef __wasm__
	fd = open("/fork-offset", O_CREAT | O_TRUNC | O_RDWR, 0600);
#else
	char path[] = "/tmp/linux-wasm-fork-offset.XXXXXX";
	fd = mkstemp(path);
	if (fd >= 0) unlink(path);
#endif
	require(fd >= 0 && write(fd, "abcdef", 6) == 6 && lseek(fd, 0, SEEK_SET) == 0, "file setup");
	sigemptyset(&mask); sigaddset(&mask, SIGUSR1);
	require(!pthread_sigmask(SIG_SETMASK, &mask, NULL), "block signal");
	require(!pthread_atfork(prepare, parent, child), "atfork registration");
	pid = indirect(5);
	require(pid >= 0, "fork");
	require(before == 1 && prepared == 1, "pre-fork effects replayed");
	require(!pthread_sigmask(SIG_SETMASK, NULL, &observed) &&
		sigismember(&observed, SIGUSR1) == 1 && sigismember(&observed, SIGUSR2) == 0, "signal mask");
	if (!pid) {
		require(getpid() != original && getppid() == original, "child identity");
		require(parents == 0 && children == 1 && tls_value == 17, "child atfork/TLS");
		require(global_value == 11 && *heap == 21 && local == 31 && mapping[0] == 51, "child snapshot");
		global_value = 101; *heap = 102; local = 103; mapping[0] = 104; tls_value = 105;
		require(read(fd, buffer, 2) == 2 && !memcmp(buffer, "ab", 2), "inherited file");
		pid_t grandchild = fork();
		require(grandchild >= 0, "nested child fork");
		if (!grandchild) {
			require(children == 2 && prepared == 2 && tls_value == 105, "grandchild state");
			_exit(23);
		}
		require(waitpid(grandchild, &status, 0) == grandchild && WIFEXITED(status) &&
			WEXITSTATUS(status) == 23, "grandchild wait");
		require(write(pipefd[1], "x", 1) == 1, "child completion");
		_exit(19);
	}
	require(parents == 1 && children == 0, "parent atfork");
	require(read(pipefd[0], buffer, 1) == 1, "wait child changes");
	require(global_value == 11 && *heap == 21 && local == 31 && mapping[0] == 51 &&
		tls_value == 17, "parent isolation");
	require(read(fd, buffer, 1) == 1 && buffer[0] == 'c', "shared open file offset");
	require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 19, "child wait");
	errno = 0;
	require(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single reap");
	puts("fork: continuation, PID, TLS, atfork, mask, memory, fd and nested wait pass");

#ifdef __wasm__
	// The kernel deliberately refuses a private snapshot while another thread
	// shares the mm. Confirm failure unwinds libc locks and permits later fork.
	pthread_t thread;
	void *thread_result;
	require(!pthread_create(&thread, NULL, blocked_thread, &pipefd[0]), "create thread");
	errno = 0;
	pid = fork();
	require(pid == -1 && errno == EOPNOTSUPP, "multithread fork must refuse");
	require(write(pipefd[1], "y", 1) == 1 && !pthread_join(thread, &thread_result) && !thread_result,
		"join after refused fork");
	for (int attempt = 0; attempt < 1000; attempt++) {
		pid = fork();
		if (pid >= 0) break;
		require(errno == EOPNOTSUPP, "unexpected recovery failure");
		sched_yield();
	}
	require(pid >= 0, "fork after failure");
	if (!pid) _exit(29);
	require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 29,
		"wait after failure");
	puts("fork: multithread refusal and recovery pass");
#else
	(void)blocked_thread;
#endif
	require(!munmap(mapping, 65536) && !close(fd) && !close(pipefd[0]) && !close(pipefd[1]), "cleanup");
	free(heap);
	puts("::vm-test::pass"); fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
