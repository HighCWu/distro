/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#ifndef __wasm__
#error This SysRq driver is only for the isolated Wasm test machine, never the build host
#endif
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: stacktrace: %s errno=%d\n", what, errno);
	fflush(stdout);
	for (;;) sched_yield();
}
#define require(ok, what) do { if (!(ok)) fail(what); } while (0)
int main(void)
{
	const char name[] = "stacktrace-test";
	if (mkdir("/proc", 0555)) require(errno == EEXIST, "proc directory");
	require(mount("proc", "/proc", "proc", 0, NULL) == 0 &&
	        prctl(PR_SET_NAME, (long)name, 0L, 0L, 0L) == 0, "mount proc and name test task");
	int trigger = open("/proc/sysrq-trigger", O_WRONLY | O_CLOEXEC);
	require(trigger >= 0, "open isolated machine diagnostic trigger");
	char *log = malloc(128 * 1024);
	require(log != NULL, "diagnostic read buffer");
	for (int iteration = 0; iteration < 2; ++iteration) {
		require(write(trigger, "t", 1) == 1, "task-state dump returns without a kernel trap");
		/* READ_CLEAR affects only this isolated test kernel. Each iteration
		 * must observe fresh diagnostics, not the previous dump's markers. */
		long length = syscall(SYS_syslog, 4L, (long)log, 128L * 1024 - 1, 0L, 0L, 0L);
		require(length > 0 && length < 128 * 1024, "bounded kernel log read");
		log[length] = 0;
		require(strstr(log, "Stack from stacktrace-test (1):") != NULL,
		        "current diagnostic identifies actual calling task");
		require(strstr(log, "unavailable: separate Wasm worker") != NULL,
		        "foreign task does not receive the current Worker's stack");
	}
	puts("stacktrace: repeated SysRq task dumps and bounded syslog reads pass");
	puts("stacktrace: current task identity and explicit unavailable remote stacks pass");
	free(log);
	require(close(trigger) == 0 && umount("/proc") == 0 && getpid() == 1,
	        "descriptor, mount and process recovery");
	puts("stacktrace: descriptor and mount cleanup with later syscall recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
	for (;;) sched_yield();
}
