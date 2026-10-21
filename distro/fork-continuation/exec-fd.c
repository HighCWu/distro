// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static _Thread_local volatile int tls = 17;
static void require(int ok, const char *message)
{
	if (ok) return;
	printf("::vm-test::fail: exec-fd: %s errno=%d\n", message, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
/* Private test adapter for the standard Linux syscall, with six explicit
 * machine-word arguments. musl supplies the public fexecve entry separately. */
static int at_exec(int fd, const char *path, char *const argv[], char *const envp[], int flags)
{
	return syscall(SYS_execveat, (long)fd, (long)path, (long)argv,
		(long)envp, (long)flags, 0L);
}
/* Linux UAPI flag values; test-local, not a new installed wrapper/API. */
enum { range_unshare = 2, range_cloexec = 4 };
static int range_close(unsigned first, unsigned last, unsigned flags)
{
	return syscall(SYS_close_range, (long)first, (long)last, (long)flags, 0L, 0L, 0L);
}
static void range_control(int data)
{
	int first = fcntl(data, F_DUPFD, 64);
	int hole = fcntl(data, F_DUPFD, 64);
	int last = fcntl(data, F_DUPFD, 64);
	require(first >= 64 && hole == first + 1 && last == hole + 1, "range fixture descriptors");
	require(close(hole) == 0, "range fixture hole");
	errno = 0;
	require(range_close(last, first, 0) == -1 && errno == EINVAL, "range reversed bounds");
	errno = 0;
	require(range_close(first, last, 1) == -1 && errno == EINVAL, "range invalid flags");
	require(fcntl(first, F_GETFD) == 0 && fcntl(last, F_GETFD) == 0, "rejection preserves descriptors");
	for (int mode = 0; mode < 2; mode++) {
		pid_t child = fork();
		require(child >= 0, "fork before range close");
		if (!child) {
			if (range_close(first, mode ? UINT_MAX : (unsigned)hole,
				mode ? range_unshare : 0) != 0) _exit(111);
			errno = 0;
			if (fcntl(first, F_GETFD) != -1 || errno != EBADF) _exit(112);
			errno = 0;
			if (mode ? (fcntl(last, F_GETFD) != -1 || errno != EBADF) :
				fcntl(last, F_GETFD) != 0) _exit(113);
			if (fcntl(data, F_GETFD) != 0) _exit(114);
			_exit(44);
		}
		int status;
		require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 44,
			"range inclusivity, holes, upper bound and child isolation");
		require(fcntl(first, F_GETFD) == 0 && fcntl(last, F_GETFD) == 0,
			"parent range remains open");
	}
	require(close(first) == 0 && close(last) == 0, "range fixture cleanup");
	puts("exec-fd: close_range bounds, holes, UNSHARE and parent isolation pass");
}
static int replaced(int argc, char **argv)
{
	if (argc != 5 || !getenv("EXEC_FD_TEST") || strcmp(getenv("EXEC_FD_TEST"), "ready")) return 101;
	if (getppid() != atoi(argv[2]) || tls != 17) return 102;
	errno = 0;
	if (fcntl(atoi(argv[3]), F_GETFD) != -1 || errno != EBADF) return 103;
	char byte;
	if (read(atoi(argv[4]), &byte, 1) != 1 || byte != 'D') return 104;
	return 43;
}
int main(int argc, char **argv)
{
	if (argc > 1 && !strcmp(argv[1], "exec-fd-child")) return replaced(argc, argv);
#ifdef __wasm__
	const char *path = "/init";
#else
	require(argc == 1 && argv[0][0] == '/', "native absolute executable path");
	const char *path = argv[0];
#endif
	int executable = open(path, O_RDONLY | O_CLOEXEC);
	require(executable >= 0, "open executable descriptor");
	char directory[PATH_MAX];
	require(strlen(path) < sizeof(directory), "executable path length");
	strcpy(directory, path);
	char *slash = strrchr(directory, '/');
	require(slash != NULL, "executable directory");
	const char *relative = strrchr(path, '/') + 1;
	if (slash == directory) slash[1] = 0;
	else *slash = 0;
	int dirfd = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	require(dirfd >= 0, "open executable directory");
#ifdef __wasm__
	int data = open("/exec-fd-data", O_CREAT | O_TRUNC | O_RDWR, 0600);
	if (data >= 0) unlink("/exec-fd-data");
#else
	char temporary[] = "/tmp/exec-fd-data.XXXXXX";
	int data = mkstemp(temporary);
	if (data >= 0) unlink(temporary);
#endif
	require(data >= 0 && write(data, "DATA", 4) == 4, "create inherited data");
	range_control(data);
	char parent[32], fdtext[32], datatext[32];
	snprintf(parent, sizeof(parent), "%ld", (long)getpid());
	snprintf(fdtext, sizeof(fdtext), "%d", executable);
	snprintf(datatext, sizeof(datatext), "%d", data);
	char *child_args[] = {"exec-fd", "exec-fd-child", parent, fdtext, datatext, NULL};
	char *child_env[] = {"EXEC_FD_TEST=ready", NULL};
	tls = 71;
	for (int mode = 0; mode < 5; mode++) {
		require(lseek(data, 0, SEEK_SET) == 0, "reset shared data offset");
		pid_t child = fork();
		require(child >= 0, "fork before descriptor exec");
		if (!child) {
			tls = 99;
			if (mode >= 3) {
				int marked = fcntl(executable, F_DUPFD, 64);
				if (marked < 64 || fcntl(marked, F_GETFD) != 0 ||
					range_close(marked, marked, range_cloexec | (mode == 4 ? range_unshare : 0)) != 0 ||
					fcntl(marked, F_GETFD) != FD_CLOEXEC) _exit(106);
				snprintf(fdtext, sizeof(fdtext), "%d", marked);
				fexecve(marked, child_args, child_env);
			}
			else if (mode == 0) fexecve(executable, child_args, child_env);
			else if (mode == 1) at_exec(executable, "", child_args, child_env, AT_EMPTY_PATH);
			else at_exec(dirfd, relative, child_args, child_env, 0);
			printf("exec-fd: mode=%d exec failed errno=%d\n", mode, errno);
			fflush(stdout);
			_exit(105);
		}
		int status;
		pid_t waited = waitpid(child, &status, 0);
		if (waited == child && (!WIFEXITED(status) || WEXITSTATUS(status) != 43))
			printf("exec-fd: replacement mode=%d wait status=%d\n", mode, status);
		require(waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 43,
			"replacement identity, TLS, inherited fd and CLOEXEC");
		char byte;
		require(read(data, &byte, 1) == 1 && byte == 'A' && tls == 71,
			"parent TLS and shared file offset after exec");
	}
	puts("exec-fd: fexecve, execveat empty path and directory-relative execution pass");
	puts("exec-fd: replacement identity, TLS, CLOEXEC and inherited file offset pass");
	puts("exec-fd: close_range CLOEXEC preserves fd until exec and closes on replacement pass");
	errno = 0;
	require(at_exec(-1, "", child_args, child_env, AT_EMPTY_PATH) == -1 && errno == EBADF,
		"execveat invalid descriptor");
	errno = 0;
	require(at_exec(executable, "", child_args, child_env, AT_EMPTY_PATH | 0x40000000) == -1 && errno == EINVAL,
		"execveat invalid flags");
	errno = 0;
	require(at_exec(dirfd, ".linux-wasm-exec-fd-missing", child_args, child_env, 0) == -1 && errno == ENOENT,
		"execveat missing relative path");
	errno = 0;
	require(fexecve(data, child_args, child_env) == -1 && errno == EACCES, "fexecve non-executable file");
	pid_t child = fork();
	require(child >= 0, "fork after rejected exec");
	if (!child) _exit(37);
	int status;
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 37 && tls == 71,
		"original image and later fork recovery");
	require(close(data) == 0 && close(dirfd) == 0 && close(executable) == 0, "descriptor cleanup");
	puts("exec-fd: standard exec errors preserve original image and later fork pass");
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
