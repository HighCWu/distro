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
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int before, prepared, parents, children;
static _Thread_local volatile int tls_value = 17;
static int global_value = 11;
static volatile sig_atomic_t signal_hits, signal_fork_refused;
static void signal_handler(int sig)
{
	int saved_errno = errno;
	if (sig == SIGUSR1) signal_hits++;
#ifdef __wasm__
	// _Fork, unlike fork, does not run application atfork handlers. The
	// current ABI must refuse unwinding across this live signal callback.
	errno = 0;
	pid_t result = _Fork();
	if (!result) _exit(116);
	signal_fork_refused = result == -1 && errno == EOPNOTSUPP;
#endif
	errno = saved_errno;
}
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

static void deliver_blocked_signal(const sigset_t *mask)
{
	require(!pthread_sigmask(SIG_UNBLOCK, mask, NULL), "unblock inherited handler");
	require(signal_hits == 1, "inherited handler delivery");
#ifdef __wasm__
	require(signal_fork_refused == 1, "signal callback must refuse _Fork");
#else
	(void)signal_fork_refused;
#endif
	require(!pthread_sigmask(SIG_BLOCK, mask, NULL), "restore blocked mask");
}

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

int main(int argc, char **argv)
{
#ifdef __wasm__
	extern int raw_clone_continuation_probe(void);
	require(raw_clone_continuation_probe(), "raw syscall continuation and recovery");
	puts("fork: raw syscall continuation, identity, isolation and wait pass");
	extern int raw_clone3_continuation_probe(void);
	require(raw_clone3_continuation_probe(), "clone3 continuation, validation and recovery");
	puts("fork: clone3 fork ABI, versioned arguments, isolation and recovery pass");
#endif
	int pipefd[2], status, fd;
	char buffer[3] = {0};
	pid_t original = getpid(), pid;
	volatile int local = 31;
	int *heap = malloc(sizeof(*heap));
	unsigned char *mapping = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	sigset_t mask, observed;
#ifdef __wasm__
	const char *exec_path = "/fork-exec";
	(void)argc; (void)argv;
#else
	require(argc == 2, "native helper argument");
	const char *exec_path = argv[1];
#endif
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
	struct sigaction action = {.sa_handler = signal_handler};
	sigemptyset(&action.sa_mask);
	require(!sigaction(SIGUSR1, &action, NULL), "install inherited handler");
	require(!pthread_sigmask(SIG_SETMASK, &mask, NULL), "block signal");
	require(!pthread_atfork(prepare, parent, child), "atfork registration");
	require(!kill(original, SIGUSR1) && !sigpending(&observed) &&
		sigismember(&observed, SIGUSR1) == 1 && !signal_hits, "queue parent signal");
	pid = indirect(5);
	require(pid >= 0, "fork");
	require(before == 1 && prepared == 1, "pre-fork effects replayed");
	require(!pthread_sigmask(SIG_SETMASK, NULL, &observed) &&
		sigismember(&observed, SIGUSR1) == 1 && sigismember(&observed, SIGUSR2) == 0, "signal mask");
	if (!pid) {
		require(!sigpending(&observed) && sigismember(&observed, SIGUSR1) == 0,
			"child inherited parent pending signal");
		require(getpid() != original && getppid() == original, "child identity");
		require(parents == 0 && children == 1 && tls_value == 17, "child atfork/TLS");
		require(global_value == 11 && *heap == 21 && local == 31 && mapping[0] == 51, "child snapshot");
		global_value = 101; *heap = 102; local = 103; mapping[0] = 104; tls_value = 105;
		require(!kill(getpid(), SIGUSR1), "queue child signal");
		deliver_blocked_signal(&mask);
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
	require(!sigpending(&observed) && sigismember(&observed, SIGUSR1) == 1 &&
		!signal_hits, "parent pending signal was consumed by child");
	deliver_blocked_signal(&mask);
	puts("fork: pending signal isolation and inherited handler pass");
	puts("fork: continuation, PID, TLS, atfork, mask, memory, fd and nested wait pass");
	fflush(stdout);

	char parent_text[32];
	require(snprintf(parent_text, sizeof parent_text, "%ld", (long)original) > 0, "format parent PID");
	char *exec_args[] = {(char *)exec_path, "hello", parent_text, NULL};
	char *exec_env[] = {"FORK_PROBE=ready", NULL};
	// Valid Wasm header, but no memory import or executable entry. On the
	// target this reaches compile_begin/end and must abort before replacing us.
	const unsigned char rejected_module[] = {0, 'a', 's', 'm', 1, 0, 0, 0};
	char rejected_path[] = "/tmp/fork-rejected-exec.XXXXXX";
	int rejected_fd = mkstemp(rejected_path);
	require(rejected_fd >= 0 &&
		write(rejected_fd, rejected_module, sizeof rejected_module) == sizeof rejected_module &&
		!fchmod(rejected_fd, 0700) && !close(rejected_fd), "rejected exec fixture");
	pid = fork();
	require(pid >= 0, "fork before exec");
	if (!pid) {
		pid_t child_pid = getpid();
		volatile int exec_sentinel = 73;
		tls_value = 99;
		errno = 0;
		require(execve("", exec_args, exec_env) == -1 && errno == ENOENT, "missing exec error");
		for (int attempt = 0; attempt < 2; attempt++) {
			errno = 0;
			require(execve(rejected_path, exec_args, exec_env) == -1 && errno == ENOEXEC,
				"rejected exec error");
			require(getpid() == child_pid && getppid() == original && tls_value == 99 &&
				exec_sentinel == 73, "rejected exec changed image");
			require(!pthread_sigmask(SIG_SETMASK, NULL, &observed) &&
				sigismember(&observed, SIGUSR1) == 1, "rejected exec changed mask");
		}
		pid_t after_failure = fork();
		require(after_failure >= 0, "fork after rejected exec");
		if (!after_failure) _exit(31);
		require(waitpid(after_failure, &status, 0) == after_failure && WIFEXITED(status) &&
			WEXITSTATUS(status) == 31, "wait after rejected exec");
		puts("fork: rejected exec preserves image and later fork pass");
		fflush(stdout);
		execve(exec_path, exec_args, exec_env);
		_exit(115);
	}
	require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 37,
		"fork then exec and wait");
	require(tls_value == 17, "exec child changed parent TLS");
	require(!unlink(rejected_path), "rejected exec fixture cleanup");
	puts("fork: exec replacement and wait pass");

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
	puts("fork: flags-first clone ABI and legacy callback coexistence pass");
	puts("fork: signal callback refusal and later fork recovery pass");
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
