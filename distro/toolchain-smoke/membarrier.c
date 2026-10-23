/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef __wasm__
#include <sys/membarrier.h>
#else
#include <linux/membarrier.h>
#endif
#include <sys/syscall.h>
#include <unistd.h>

/* Standard Linux command, not yet named by the pinned libc header. */
#ifndef MEMBARRIER_CMD_GET_REGISTRATIONS
#define MEMBARRIER_CMD_GET_REGISTRATIONS (1 << 9)
#endif

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: membarrier: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

/* Do not link libc's membarrier fallback or its implicit pre-registration.
 * Every syscall argument, including unused registers, is a machine word. */
static long command(int cmd, int flags)
{
	return syscall(SYS_membarrier, (long)cmd, (long)flags, 0L, 0L, 0L, 0L);
}

static void pin(int cpu)
{
	cpu_set_t selected;
	CPU_ZERO(&selected);
	CPU_SET(cpu, &selected);
	require(sched_setaffinity(0, sizeof selected, &selected) == 0 && sched_getcpu() == cpu,
	        "pin thread to a distinct online CPU");
}

static atomic_int generation, completed, x, y;
static int worker_read;
static int worker_cpu;
enum { rounds = 128 };

static void *worker(void *unused)
{
	(void)unused;
	pin(worker_cpu);
	for (int round = 1; round <= rounds; ++round) {
		/* Cooperative syscall boundaries service Wasm IPIs. No claim is
		 * made that a pure userspace infinite loop can be preempted. */
		while (atomic_load_explicit(&generation, memory_order_acquire) < round)
			sched_yield();
		atomic_store_explicit(&y, 1, memory_order_relaxed);
		__asm__ __volatile__("" ::: "memory");
		worker_read = atomic_load_explicit(&x, memory_order_relaxed);
		atomic_store_explicit(&completed, round, memory_order_release);
	}
	return NULL;
}

int main(void)
{
	const int basic = MEMBARRIER_CMD_GLOBAL | MEMBARRIER_CMD_GLOBAL_EXPEDITED |
		MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED | MEMBARRIER_CMD_PRIVATE_EXPEDITED |
		MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED;
	long query = command(MEMBARRIER_CMD_QUERY, 0);
	require(query >= 0 && (query & basic) == basic, "query exposes ordinary Linux commands");
	require(command(MEMBARRIER_CMD_QUERY, 1) == -1 && errno == EINVAL &&
	        command(-1, 0) == -1 && errno == EINVAL, "invalid flags and command rejected");
	require(command(MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0) == -1 && errno == EPERM,
	        "unregistered private barrier rejected");
#ifdef __wasm__
	const int unsupported = MEMBARRIER_CMD_PRIVATE_EXPEDITED_SYNC_CORE |
		MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED_SYNC_CORE |
		MEMBARRIER_CMD_PRIVATE_EXPEDITED_RSEQ | MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED_RSEQ;
	require(!(query & unsupported), "no invented sync-core or rseq support");
	for (int bit = MEMBARRIER_CMD_PRIVATE_EXPEDITED_SYNC_CORE;
	     bit <= MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED_RSEQ; bit <<= 1)
		require(command(bit, 0) == -1 && errno == EINVAL, "unavailable architecture command rejected");
#endif
	puts("membarrier: standard query, invalid arguments and registration requirement pass");

	require(command(MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED, 0) == 0 &&
	        command(MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED, 0) == 0 &&
	        command(MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED, 0) == 0 &&
	        command(MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0) == 0 &&
	        command(MEMBARRIER_CMD_GLOBAL_EXPEDITED, 0) == 0 &&
	        command(MEMBARRIER_CMD_GLOBAL, 0) == 0, "registration, idempotence and single-thread barriers");
#ifdef __wasm__
	require(query & MEMBARRIER_CMD_GET_REGISTRATIONS, "current Linux registration-query command present");
#endif
	if (query & MEMBARRIER_CMD_GET_REGISTRATIONS)
		require(command(MEMBARRIER_CMD_GET_REGISTRATIONS, 0) ==
		        (MEMBARRIER_CMD_REGISTER_PRIVATE_EXPEDITED | MEMBARRIER_CMD_REGISTER_GLOBAL_EXPEDITED),
		        "registration state matches both requested registrations");
	puts("membarrier: private/global registration, state and single-thread execution pass");

	cpu_set_t original;
	require(sched_getaffinity(0, sizeof original, &original) == 0, "read original affinity");
	int caller_cpu = -1;
	worker_cpu = -1;
	for (int cpu = 0; cpu < CPU_SETSIZE; ++cpu) {
		if (!CPU_ISSET(cpu, &original)) continue;
		if (caller_cpu < 0) caller_cpu = cpu;
		else { worker_cpu = cpu; break; }
	}
	require(worker_cpu >= 0, "two allowed CPUs required, not a silently skipped SMP test");
	pin(caller_cpu);
	pthread_t thread;
	require(pthread_create(&thread, NULL, worker, NULL) == 0, "create shared-memory peer");
	for (int round = 1; round <= rounds; ++round) {
		atomic_store_explicit(&x, 0, memory_order_relaxed);
		atomic_store_explicit(&y, 0, memory_order_relaxed);
		atomic_store_explicit(&generation, round, memory_order_release);
		atomic_store_explicit(&x, 1, memory_order_relaxed);
		require(command(MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0) == 0, "SMP private expedited barrier");
		int caller_read = atomic_load_explicit(&y, memory_order_relaxed);
		while (atomic_load_explicit(&completed, memory_order_acquire) < round)
			sched_yield();
		require(caller_read || worker_read, "forbidden two-zero barrier/compiler-barrier outcome");
		if (round < rounds && round % 16 == 0)
			require(command(MEMBARRIER_CMD_GLOBAL_EXPEDITED, 0) == 0 &&
			        command(MEMBARRIER_CMD_GLOBAL, 0) == 0, "SMP global barriers");
	}
	require(pthread_join(thread, NULL) == 0 &&
	        sched_setaffinity(0, sizeof original, &original) == 0 &&
	        command(MEMBARRIER_CMD_PRIVATE_EXPEDITED, 0) == 0,
	        "join, restore affinity and later barrier recovery");
	puts("membarrier: distinct-CPU threaded ordering, global barriers and post-join recovery pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
}
