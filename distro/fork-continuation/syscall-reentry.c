/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int allocator_active;
static volatile unsigned long nested_calls;
static pid_t tracee;

int __real_pthread_mutex_lock(pthread_mutex_t *);
int __wrap_pthread_mutex_lock(pthread_mutex_t *mutex)
{
	if (allocator_active) {
		allocator_active = 0;
		nested_calls++;
		if (syscall(SYS_getpid, 0L, 0L, 0L, 0L, 0L, 0L) <= 0) _exit(111);
		allocator_active = 1;
	}
	return __real_pthread_mutex_lock(mutex);
}
static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: syscall-reentry: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	if (tracee > 0) {
		int status;
		pid_t owned;
		do owned = waitpid(tracee, &status, WNOHANG); while (owned < 0 && errno == EINTR);
		if (!owned || (owned == tracee && WIFSTOPPED(status))) {
			kill(tracee, SIGKILL);
			while (waitpid(tracee, NULL, 0) < 0 && errno == EINTR) {}
		}
	}
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
static int wait_tracee(void)
{
	int status;
	pid_t waited;
	do waited = waitpid(tracee, &status, 0); while (waited < 0 && errno == EINTR);
	require(waited == tracee, "wait exact tracee");
	return status;
}
/* Standard Linux PTRACE_GET_SYSCALL_INFO wire shape, private to this test.
 * EXIT has no syscall number/arguments; /proc/PID/syscall supplies those. */
struct syscall_info {
	uint8_t operation, pad[3];
	uint32_t arch;
	uint64_t ip, sp;
	union {
		struct { uint64_t number, args[6]; } entry;
		struct { int64_t value; uint8_t error; } exit;
	} data;
};
struct frame {
	uint64_t number, args[6], sp;
};
static void check_proc(const struct frame *frame)
{
	char path[64];
	int count = snprintf(path, sizeof path, "/proc/%ld/syscall", (long)tracee);
	require(count > 0 && count < (int)sizeof path, "proc syscall path");
	FILE *file = fopen(path, "r");
	require(file != NULL, "open stopped syscall metadata");
	long number;
	unsigned long args[6], sp;
	count = fscanf(file, "%ld %lx %lx %lx %lx %lx %lx %lx", &number,
	               &args[0], &args[1], &args[2], &args[3], &args[4], &args[5], &sp);
	require(fclose(file) == 0 && count == 8 && number >= 0 &&
	        (uint64_t)number == frame->number && (uint64_t)sp == frame->sp,
	        "stopped exit keeps outer syscall number and C stack");
	for (int i = 0; i < 6; i++)
		require((uint64_t)args[i] == frame->args[i], "stopped exit keeps entered syscall arguments");
}
static _Noreturn void child(void)
{
	if (request(PTRACE_TRACEME, 0, 0, 0) ||
	    syscall(SYS_tkill, (long)getpid(), (long)SIGSTOP, 0L, 0L, 0L, 0L)) _exit(112);
	allocator_active = 1;
	unsigned char *mapping = mmap(NULL, 65536, PROT_READ | PROT_WRITE,
	                              MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	allocator_active = 0;
	if (mapping == MAP_FAILED || mapping[0]) _exit(113);
	mapping[0] = 'R';
	allocator_active = 1;
	int released = munmap(mapping, 65536);
	allocator_active = 0;
	if (released) _exit(114);
#ifdef __wasm__
	/* Do not pass just because the linker failed to wrap the allocator's
	 * actual mutex calls. Native mmap has no user allocator callback. */
	if (nested_calls < 2) _exit(115);
#endif
	_exit(42);
}
int main(void)
{
#ifdef __wasm__
	require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc directory");
	require(mount("proc", "/proc", "proc", 0, NULL) == 0, "proc mount");
#endif
	tracee = fork();
	require(tracee >= 0, "create tracee");
	if (!tracee) child();
	int status = wait_tracee();
	require(WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP &&
	        request(PTRACE_SETOPTIONS, tracee, 0, PTRACE_O_TRACESYSGOOD) == 0,
	        "initial stop and syscall tracing options");
	struct frame frames[8];
	size_t depth = 0, nested = 0, exits = 0;
	for (unsigned stops = 0;; stops++) {
		require(stops < 512 && request(PTRACE_SYSCALL, tracee, 0, 0) == 0, "resume bounded syscall tracing");
		status = wait_tracee();
		if (WIFEXITED(status) || WIFSIGNALED(status)) break;
		require(WIFSTOPPED(status) && WSTOPSIG(status) == (SIGTRAP | 0x80), "syscall stop identity");
		struct syscall_info info = {0};
		long length = request(PTRACE_GET_SYSCALL_INFO, tracee, sizeof info, (unsigned long)&info);
		require(length >= 24 && length <= (long)sizeof info, "syscall-info wire size");
		if (info.operation == 1) {
			require(length >= 80 && depth < 8, "entry info and bounded nested frame stack");
			struct frame *frame = &frames[depth++];
			frame->number = info.data.entry.number;
			frame->sp = info.sp;
			for (int i = 0; i < 6; i++) frame->args[i] = info.data.entry.args[i];
			if (depth > 1) {
				require(frame->number == SYS_getpid, "nested call belongs to allocator wrapper");
				nested++;
			}
		} else {
			require(info.operation == 2 && length >= 33 && depth > 0, "paired syscall exit");
			check_proc(&frames[--depth]);
			exits++;
		}
	}
	require(WIFEXITED(status) && WEXITSTATUS(status) == 42 && exits > 0 && depth == 1 &&
	        (frames[0].number == SYS_exit_group || frames[0].number == SYS_exit),
	        "mapping/release succeeds and only terminal exit has no return stop");
	tracee = 0;
#ifdef __wasm__
	require(nested >= 2, "real allocator callback syscalls were observed, not skipped");
	require(umount("/proc") == 0, "proc cleanup");
#else
	require(nested == 0, "native reference has ordinary flat kernel mmap");
#endif
	puts("syscall-reentry: entered arguments, outer exit number and C stack survive nested callbacks pass");
	puts("syscall-reentry: allocator callback observation, mmap/munmap data and tracee reap pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
