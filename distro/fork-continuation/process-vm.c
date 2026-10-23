/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

#define BYTES 70001
static unsigned char remote_data[BYTES], received[BYTES], payload[BYTES];
static pid_t active_child;
static void require(int ok, const char *what);

/* Standard Linux capability wire format, private to this workload. No libc
 * API is added. Restore the original effective set before checking refusal. */
static void check_permission(pid_t child)
{
	struct { uint32_t version; int pid; } header = {0x20080522, 0};
	struct capability_data { uint32_t effective, permitted, inheritable; } saved[2], limited[2];
	require(syscall(SYS_capget, (long)&header, (long)saved, 0L, 0L, 0L, 0L) == 0,
	        "read current capabilities");
	memcpy(limited, saved, sizeof saved);
	limited[0].effective &= ~(UINT32_C(1) << 19); /* CAP_SYS_PTRACE */
	require(syscall(SYS_capset, (long)&header, (long)limited, 0L, 0L, 0L, 0L) == 0,
	        "temporarily drop ptrace override");
	struct iovec local = {received, 8}, remote = {remote_data, 8};
	errno = 0;
	ssize_t result = process_vm_readv(child, &local, 1, &remote, 1, 0);
	int error = errno;
	errno = 0;
	ssize_t written = process_vm_writev(child, &local, 1, &remote, 1, 0);
	int write_error = errno;
	long restored = syscall(SYS_capset, (long)&header, (long)saved, 0L, 0L, 0L, 0L);
	require(restored == 0 && result == -1 && error == EPERM &&
	        written == -1 && write_error == EPERM,
	        "non-dumpable child denied without ptrace capability");
}

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: process-vm: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	if (active_child > 0) {
		int status;
		pid_t waited = waitpid(active_child, &status, WNOHANG);
		if (!waited) {
			kill(active_child, SIGKILL);
			while (waitpid(active_child, NULL, 0) == -1 && errno == EINTR) {}
		}
	}
	exit(1);
#endif
}

int main(void)
{
	int ready[2], resume[2], status;
	char token;
	memset(remote_data, 'P', sizeof remote_data);
	for (size_t i = 0; i < sizeof payload; ++i) payload[i] = (unsigned char)(i * 37 + 11);
	require(pipe(ready) == 0 && pipe(resume) == 0, "coordination pipes");
	pid_t child = fork();
	require(child >= 0, "fork independent address space");
	if (!child) {
		close(ready[0]);
		close(resume[1]);
		memset(remote_data, 'C', sizeof remote_data);
		if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) || write(ready[1], "p", 1) != 1 ||
		    read(resume[0], &token, 1) != 1 || token != 'p' ||
		    prctl(PR_SET_DUMPABLE, 1L, 0L, 0L, 0L)) _exit(110);
		if (write(ready[1], "r", 1) != 1 || read(resume[0], &token, 1) != 1) _exit(111);
		if (memcmp(remote_data, payload, sizeof payload)) _exit(112);
		close(ready[1]);
		close(resume[0]);
		_exit(37);
	}
	active_child = child;
	require(close(ready[1]) == 0 && close(resume[0]) == 0 && read(ready[0], &token, 1) == 1,
	        "child parked after publishing its own bytes");
	check_permission(child);
	require(write(resume[1], "p", 1) == 1 && read(ready[0], &token, 1) == 1 && token == 'r',
	        "child restores dumpable state after permission refusal");
	struct iovec local[] = {{received, 13}, {received + 13, BYTES - 13}};
	struct iovec remote[] = {{remote_data, 65539}, {remote_data + 65539, BYTES - 65539}};
	require(process_vm_readv(child, local, 2, remote, 2, 0) == BYTES,
	        "multi-vector read crosses copy and Wasm page boundaries");
	for (size_t i = 0; i < sizeof received; ++i)
		require(received[i] == 'C' && remote_data[i] == 'P', "remote bytes and parent isolation");
	puts("process-vm: permission refusal, independent child reads, vector ordering and page crossings pass");

	struct iovec partial_remote[] = {{remote_data, 8}, {(void *)(uintptr_t)-1, 8}};
	struct iovec prefix = {received, 16};
	memset(received, 0, 16);
	require(process_vm_readv(child, &prefix, 1, partial_remote, 2, 0) == 8 &&
	        received[0] == 'C' && received[7] == 'C' && received[8] == 0,
	        "remote fault returns only the committed prefix");
	errno = 0;
	require(process_vm_readv(child, &prefix, 1, partial_remote + 1, 1, 0) == -1 && errno == EFAULT,
	        "first remote fault returns EFAULT");
	errno = 0;
	require(process_vm_readv(child, &prefix, 1, remote, 2, 1) == -1 && errno == EINVAL,
	        "reserved flags rejected");
	errno = 0;
	require(process_vm_readv(child, &prefix, ULONG_MAX, remote, 2, 0) == -1 && errno == EINVAL,
	        "excess local vector count rejected");
	errno = 0;
	require(process_vm_readv(INT_MAX, &prefix, 1, remote, 2, 0) == -1 && errno == ESRCH,
	        "nonexistent task rejected");
	require(process_vm_readv(INT_MAX, &prefix, 0, remote, 2, 0) == 0,
	        "zero local transfer keeps Linux fast-path semantics");
	require(process_vm_readv(INT_MAX, &prefix, 1, &(struct iovec){remote_data, 0}, 1, 0) == 0,
	        "zero remote transfer does not look up a task");
	local[0] = (struct iovec){payload, 13};
	local[1] = (struct iovec){payload + 13, BYTES - 13};
	require(process_vm_writev(child, local, 2, remote, 2, 0) == BYTES &&
	        process_vm_readv(child, &(struct iovec){received, BYTES}, 1, remote, 2, 0) == BYTES &&
	        !memcmp(received, payload, BYTES), "remote write followed by full readback");
	puts("process-vm: partial transfers, kernel errors and actual remote writes pass");

	require(write(resume[1], "v", 1) == 1 && waitpid(child, &status, 0) == child &&
	        WIFEXITED(status) && WEXITSTATUS(status) == 37,
	        "child actually observes written payload and exits");
	active_child = 0;
	errno = 0;
	require(process_vm_readv(child, &prefix, 1, remote, 2, 0) == -1 && errno == ESRCH,
	        "reaped task memory cannot be reused");
	require(close(ready[0]) == 0 && close(resume[1]) == 0, "close parent pipe endpoints");
	struct iovec self_remote = {payload, 16};
	require(process_vm_readv(getpid(), &prefix, 1, &self_remote, 1, 0) == 16 &&
	        !memcmp(received, payload, 16), "current mm copy after remote lifecycle cleanup");
	child = fork();
	require(child >= 0, "later ordinary fork");
	if (!child) _exit(38);
	active_child = child;
	require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 38,
	        "later fork and wait recovery");
	active_child = 0;
	puts("process-vm: child observation, reap, self access and later fork recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
}
