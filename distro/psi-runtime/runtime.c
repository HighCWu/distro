/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

struct pressure { uint64_t some, full; };
struct workload {
	atomic_int stop, ready;
	uint64_t deadline;
};
struct worker {
	struct workload *work;
	uint64_t iterations, checksum;
};

static void fail(const char *stage)
{
	printf("::vm-test::fail: psi-runtime: %s errno=%d\n", stage, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(condition, stage) do { if (!(condition)) fail(stage); } while (0)

static uint64_t now_ns(void)
{
	struct timespec value;
	CHECK(!clock_gettime(CLOCK_MONOTONIC, &value) && value.tv_sec >= 0 &&
	      value.tv_nsec >= 0 && value.tv_nsec < 1000000000, "bounded monotonic clock");
	return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

static struct pressure read_pressure(const char *path)
{
	FILE *file = fopen(path, "r");
	CHECK(file, "open stock pressure record");
	struct pressure result = {0};
	for (int row = 0; row < 2; ++row) {
		char line[256], label[8];
		double avg10, avg60, avg300;
		uint64_t total;
		int end = 0;
		CHECK(fgets(line, sizeof(line), file) &&
		      sscanf(line, "%7s avg10=%lf avg60=%lf avg300=%lf total=%" SCNu64 "%n",
		             label, &avg10, &avg60, &avg300, &total, &end) == 5 &&
		      !strcmp(label, row == 0 ? "some" : "full") &&
		      !strcmp(line + end, "\n") && avg10 >= 0 && avg10 <= 100 &&
		      avg60 >= 0 && avg60 <= 100 && avg300 >= 0 && avg300 <= 100,
		      "parse pressure some/full averages and microsecond totals");
		if (row == 0) result.some = total;
		else result.full = total;
	}
	CHECK(fgetc(file) == EOF && !ferror(file) && !fclose(file), "complete pressure record");
	return result;
}

static void *run_worker(void *opaque)
{
	struct worker *worker = opaque;
	struct workload *work = worker->work;
	uint64_t checksum = 1;
	atomic_fetch_add_explicit(&work->ready, 1, memory_order_release);
	while (!atomic_load_explicit(&work->stop, memory_order_acquire) && now_ns() < work->deadline) {
		for (unsigned i = 0; i < 4096; ++i) {
			checksum ^= checksum << 13;
			checksum ^= checksum >> 7;
			checksum ^= checksum << 17;
		}
		++worker->iterations;
		// Remain runnable rather than sleeping; two such threads on one CPU
		// create actual scheduler pressure while retaining cooperative progress.
		CHECK(!sched_yield(), "runnable worker yield");
	}
	worker->checksum = checksum;
	return NULL;
}

int main(int argc, char **argv)
{
	setvbuf(stdout, NULL, _IONBF, 0);
	CHECK(argc == 1 || (argc == 2 && !strcmp(argv[1], "--proc-only")), "supported fixture arguments");
	const int require_trigger = argc == 1;
#ifdef __wasm__
	CHECK(require_trigger, "target requires real pressure trigger acceptance");
	CHECK(!mkdir("/proc", 0755) || errno == EEXIST, "create procfs mountpoint");
	CHECK(!mount("proc", "/proc", "proc", 0, NULL) || errno == EBUSY, "mount procfs");
#else
	// Inherit a single permitted CPU into both workers without assuming CPU0
	// belongs to the native process's cpuset. Restore the original mask later.
	cpu_set_t original, one;
	CHECK(!sched_getaffinity(0, sizeof(original), &original), "read permitted CPU affinity");
	CPU_ZERO(&one);
	for (int cpu = 0; cpu < CPU_SETSIZE; ++cpu) {
		if (CPU_ISSET(cpu, &original)) { CPU_SET(cpu, &one); break; }
	}
	CHECK(CPU_COUNT(&one) == 1 && !sched_setaffinity(0, sizeof(one), &one), "pin contention to one permitted CPU");
#endif
	struct pressure before = read_pressure("/proc/pressure/cpu");
	(void)read_pressure("/proc/pressure/memory");
	(void)read_pressure("/proc/pressure/io");
	puts("psi-runtime: parsed stock CPU memory and IO some/full records pass");
	int trigger = -1;
	if (require_trigger) {
		trigger = open("/proc/pressure/cpu", O_RDWR | O_NONBLOCK | O_CLOEXEC);
		CHECK(trigger >= 0, "open writable CPU pressure trigger");
		static const char command[] = "some 1000 2000000";
		// psi_write terminates the last supplied byte, so include the NUL.
		CHECK(write(trigger, command, sizeof(command)) == (ssize_t)sizeof(command),
		      "register stock CPU some stall trigger");
	}

	const uint64_t start = now_ns();
	struct workload work = {.deadline = start + UINT64_C(8000000000)};
	atomic_init(&work.stop, 0);
	atomic_init(&work.ready, 0);
	pthread_t threads[2];
	struct worker workers[2] = {{.work = &work}, {.work = &work}};
	for (int i = 0; i < 2; ++i) {
		int error = pthread_create(&threads[i], NULL, run_worker, &workers[i]);
		if (error) {
			atomic_store_explicit(&work.stop, 1, memory_order_release);
			for (int previous = 0; previous < i; ++previous) (void)pthread_join(threads[previous], NULL);
			errno = error;
			fail("create runnable pressure workers");
		}
	}
	int seen = 0, poll_error = 0;
	struct pressure after = before;
	while (now_ns() < work.deadline) {
		struct pollfd descriptor = {.fd = trigger, .events = POLLPRI};
		int result = poll(&descriptor, trigger >= 0 ? 1 : 0, 100);
		if (result < 0 && errno == EINTR) continue;
		if (result < 0 || (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL))) {
			poll_error = errno ? errno : EIO;
			break;
		}
		if (descriptor.revents & POLLPRI) seen = 1;
		after = read_pressure("/proc/pressure/cpu");
		if (atomic_load_explicit(&work.ready, memory_order_acquire) == 2 &&
		    now_ns() - start >= UINT64_C(250000000) && after.some > before.some &&
		    (!require_trigger || seen)) break;
	}
	atomic_store_explicit(&work.stop, 1, memory_order_release);
	for (int i = 0; i < 2; ++i) {
		int error = pthread_join(threads[i], NULL);
		if (error) { errno = error; fail("join finite pressure worker"); }
		CHECK(workers[i].iterations && workers[i].checksum, "both pressure workers ran and stopped");
	}
	if (trigger >= 0) CHECK(!close(trigger), "close pressure trigger");
#ifndef __wasm__
	CHECK(!sched_setaffinity(0, sizeof(original), &original), "restore native CPU affinity");
#endif
	errno = poll_error;
	CHECK(!poll_error, "pressure trigger polling");
	CHECK(after.some > before.some, "CPU some total advances under runnable contention");
	(void)read_pressure("/proc/pressure/memory");
	(void)read_pressure("/proc/pressure/io");
	puts("psi-runtime: single CPU runnable contention advances some total and joins workers pass");
	if (!require_trigger) {
		puts("psi-runtime: native proc-only contention smoke pass (not target trigger acceptance)");
		return 0;
	}
	CHECK(seen, "registered CPU pressure trigger produced real POLLPRI");
	puts("psi-runtime: registered CPU some trigger delivers POLLPRI and closes pass");
	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;) (void)sched_yield();
#else
	return 0;
#endif
}
