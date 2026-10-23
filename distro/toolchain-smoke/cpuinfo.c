// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>

static atomic_int ready, stop;
static atomic_ulong progress;
static pthread_t worker;
static int started, other_cpu;

static _Noreturn void fail(const char *message)
{
	atomic_store(&stop, 1);
	if (started) pthread_join(worker, NULL);
	fprintf(stderr, "cpuinfo: %s (errno=%d)\n", message, errno);
	exit(1);
}
static void require(int condition, const char *message)
{
	if (!condition) fail(message);
}
static void *compute(void *unused)
{
	(void)unused;
	cpu_set_t mask;
	CPU_ZERO(&mask);
	CPU_SET(other_cpu, &mask);
	if (sched_setaffinity(0, sizeof mask, &mask)) {
		atomic_store(&ready, -1);
		return NULL;
	}
	atomic_fetch_add_explicit(&progress, 1, memory_order_relaxed);
	atomic_store(&ready, 1);
	/* Deliberately no syscalls until the reader releases this CPU. */
	while (!atomic_load_explicit(&stop, memory_order_acquire))
		atomic_fetch_add_explicit(&progress, 1, memory_order_relaxed);
	return NULL;
}
static void read_cpuinfo(int first, int second)
{
	FILE *file = fopen("/proc/cpuinfo", "r");
	require(file != NULL, "open cpuinfo while another CPU computes");
	char line[512];
	cpu_set_t seen;
	CPU_ZERO(&seen);
	unsigned count = 0;
	while (fgets(line, sizeof line, file)) {
		unsigned cpu;
		if (sscanf(line, "processor : %u", &cpu) != 1) continue;
		require(cpu < CPU_SETSIZE && !CPU_ISSET(cpu, &seen), "unique bounded processor number");
		CPU_SET(cpu, &seen);
		count++;
	}
	require(!ferror(file) && fclose(file) == 0, "complete cpuinfo read and close");
	require(CPU_ISSET(first, &seen) && CPU_ISSET(second, &seen), "both active CPUs are listed");
#ifdef __wasm__
	require(count == 2, "two-CPU target has exactly two processor records");
#else
	require(count >= 2, "native reference has at least two processor records");
#endif
}
int main(void)
{
#ifdef __wasm__
	require(mkdir("/proc", 0555) == 0 || errno == EEXIST, "proc directory");
	require(mount("proc", "/proc", "proc", 0, NULL) == 0, "proc mount");
#endif
	cpu_set_t original, pinned;
	require(sched_getaffinity(0, sizeof original, &original) == 0, "get allowed CPUs");
	int first = -1;
	other_cpu = -1;
	for (int cpu = 0; cpu < CPU_SETSIZE; cpu++) {
		if (!CPU_ISSET(cpu, &original)) continue;
		if (first < 0) first = cpu;
		else { other_cpu = cpu; break; }
	}
	require(first >= 0 && other_cpu >= 0, "two allowed CPUs");
	CPU_ZERO(&pinned);
	CPU_SET(first, &pinned);
	require(sched_setaffinity(0, sizeof pinned, &pinned) == 0, "pin reader CPU");
	require(pthread_create(&worker, NULL, compute, NULL) == 0, "create compute thread");
	started = 1;
	struct timespec deadline, now;
	require(clock_gettime(CLOCK_MONOTONIC, &deadline) == 0, "startup deadline");
	deadline.tv_sec += 5;
	while (!atomic_load(&ready)) {
		require(clock_gettime(CLOCK_MONOTONIC, &now) == 0 &&
		        (now.tv_sec < deadline.tv_sec ||
		         (now.tv_sec == deadline.tv_sec && now.tv_nsec < deadline.tv_nsec)), "compute startup bounded");
		sched_yield();
	}
	require(atomic_load(&ready) == 1, "compute thread owns another CPU");
	for (int round = 0; round < 3; round++) read_cpuinfo(first, other_cpu);
	puts("cpuinfo: repeated proc reads complete while another CPU makes no syscalls pass");
	atomic_store(&stop, 1);
	require(pthread_join(worker, NULL) == 0, "join released compute thread");
	started = 0;
	require(atomic_load(&progress) > 0, "compute thread actually ran");
	require(sched_setaffinity(0, sizeof original, &original) == 0, "restore reader affinity");
	read_cpuinfo(first, other_cpu);
#ifdef __wasm__
	require(umount("/proc") == 0, "proc cleanup");
#endif
	puts("cpuinfo: thread release, affinity restoration and subsequent read pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	return 0;
#endif
}
