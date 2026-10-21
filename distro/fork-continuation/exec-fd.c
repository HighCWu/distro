// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
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
	for (int mode = 0; mode < 3; mode++) {
		pid_t child = fork();
		require(child >= 0, "fork before range close");
		if (!child) {
			unsigned end = mode == 2 ? UINT_MAX : (unsigned)(mode == 1 ? last : first);
			if (range_close(first, end, mode == 2 ? range_unshare : 0) != 0) _exit(111);
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
static void limit_control(struct rlimit *files)
{
	_Static_assert(sizeof(rlim_t) == 8 && sizeof(struct rlimit) == 16, "Linux prlimit64 layout");
	struct rlimit observed, invalid = {1, 0};
	require(getrlimit(RLIMIT_NOFILE, files) == 0 && files->rlim_cur >= 96,
		"read initial file limit");
	require(prlimit(0, RLIMIT_NOFILE, NULL, &observed) == 0 &&
		observed.rlim_cur == files->rlim_cur && observed.rlim_max == files->rlim_max,
		"prlimit and getrlimit agree");
	errno = 0;
	require(setrlimit(RLIMIT_NOFILE, &invalid) == -1 && errno == EINVAL, "invalid soft above hard limit");
	errno = 0;
	require(prlimit(0, -1, NULL, &observed) == -1 && errno == EINVAL, "invalid resource selector");
	errno = 0;
	require(syscall(SYS_prlimit64, 0L, (long)RLIMIT_NOFILE, 0L, -8L, 0L, 0L) == -1 &&
		errno == EFAULT, "prlimit invalid output pointer");
	errno = 0;
	require(syscall(SYS_prlimit64, 0L, (long)RLIMIT_NOFILE, -8L, 0L, 0L, 0L) == -1 &&
		errno == EFAULT, "prlimit invalid input pointer");
	require(getrlimit(RLIMIT_NOFILE, &observed) == 0 &&
		observed.rlim_cur == files->rlim_cur && observed.rlim_max == files->rlim_max,
		"rejected limit requests preserve original limit");
	struct rlimit core, wide;
	const rlim_t values[] = {0xfffffff0ULL, 0x100000007ULL};
	require(getrlimit(RLIMIT_CORE, &core) == 0 && core.rlim_max == RLIM_INFINITY, "wide core limit precondition");
	for (unsigned i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
		const rlim_t high = values[i];
		/* Linux rlim64_is_infinity saturates at ULONG_MAX on 32-bit kernels.
		 * The public structure still returns the full 64-bit infinity value. */
		const rlim_t expected = sizeof(unsigned long) == 4 && high >= 0xffffffffULL ? RLIM_INFINITY : high;
		wide = core;
		wide.rlim_cur = high;
		errno = 0;
		require(setrlimit(RLIMIT_CORE, &wide) == 0 && prlimit(0, RLIMIT_CORE, NULL, &observed) == 0 &&
			observed.rlim_cur == expected && observed.rlim_max == core.rlim_max, "full-width core limit roundtrip");
	}
	require(setrlimit(RLIMIT_CORE, &core) == 0 && getrlimit(RLIMIT_CORE, &observed) == 0 &&
		observed.rlim_cur == core.rlim_cur && observed.rlim_max == core.rlim_max, "restore core limit");
	puts("exec-fd: prlimit64 errors, libc limits and full-width rlim_t roundtrip pass");
}
static int child_limit(int data, const struct rlimit *original)
{
	struct rlimit reduced = *original, previous, observed;
	reduced.rlim_cur = 32;
	if (prlimit(0, RLIMIT_NOFILE, &reduced, &previous) ||
		previous.rlim_cur != original->rlim_cur || previous.rlim_max != original->rlim_max ||
		getrlimit(RLIMIT_NOFILE, &observed) || observed.rlim_cur != 32 ||
		observed.rlim_max != original->rlim_max) return 0;
	int copies[32], count = 0, exhausted = 0;
	while (count < 32) {
		int fd = dup(data);
		if (fd < 0) { exhausted = errno == EMFILE; break; }
		copies[count++] = fd;
	}
	for (int i = 0; i < count; i++) if (close(copies[i])) return 0;
	return count > 0 && exhausted;
}
static int replaced(int argc, char **argv)
{
	if (argc != 7 || !getenv("EXEC_FD_TEST") || strcmp(getenv("EXEC_FD_TEST"), "ready")) return 101;
	if (getppid() != atoi(argv[2]) || tls != 17) return 102;
	errno = 0;
	if (fcntl(atoi(argv[3]), F_GETFD) != -1 || errno != EBADF) return 103;
	char byte;
	if (read(atoi(argv[4]), &byte, 1) != 1 || byte != 'D') return 104;
	struct rlimit limit;
	if (getrlimit(RLIMIT_NOFILE, &limit) || limit.rlim_cur != strtoull(argv[5], NULL, 10) ||
		limit.rlim_max != strtoull(argv[6], NULL, 10)) return 108;
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
	struct rlimit files;
	limit_control(&files);
	char parent[32], fdtext[32], datatext[32], soft[32], hard[32];
	snprintf(parent, sizeof(parent), "%ld", (long)getpid());
	snprintf(fdtext, sizeof(fdtext), "%d", executable);
	snprintf(datatext, sizeof(datatext), "%d", data);
	snprintf(soft, sizeof(soft), "%llu", (unsigned long long)files.rlim_cur);
	snprintf(hard, sizeof(hard), "%llu", (unsigned long long)files.rlim_max);
	char *child_args[] = {"exec-fd", "exec-fd-child", parent, fdtext, datatext, soft, hard, NULL};
	char *child_env[] = {"EXEC_FD_TEST=ready", NULL};
	tls = 71;
	for (int mode = 0; mode < 6; mode++) {
		require(lseek(data, 0, SEEK_SET) == 0, "reset shared data offset");
		pid_t child = fork();
		require(child >= 0, "fork before descriptor exec");
		if (!child) {
			tls = 99;
			if (mode == 5) {
				if (!child_limit(data, &files)) _exit(107);
				snprintf(soft, sizeof(soft), "%u", 32U);
				fexecve(executable, child_args, child_env);
			}
			else if (mode >= 3) {
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
		struct rlimit unchanged;
		require(getrlimit(RLIMIT_NOFILE, &unchanged) == 0 && unchanged.rlim_cur == files.rlim_cur &&
			unchanged.rlim_max == files.rlim_max, "parent limits unaffected by child");
	}
	puts("exec-fd: fexecve, execveat empty path and directory-relative execution pass");
	puts("exec-fd: replacement identity, TLS, CLOEXEC and inherited file offset pass");
	puts("exec-fd: close_range CLOEXEC preserves fd until exec and closes on replacement pass");
	puts("exec-fd: child NOFILE enforcement, exec inheritance and parent limit isolation pass");
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
