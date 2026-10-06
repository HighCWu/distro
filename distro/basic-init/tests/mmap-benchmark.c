// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include "test.h"

#include <inttypes.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

enum { max_mappings = 256, max_threads = 4, batch_size = 8,
	iterations = 32, samples = 3 };

static size_t page_size;

struct measurement {
	uint64_t mmap_ns, munmap_ns;
	size_t operations;
};

struct gate {
	_Atomic int ready, start, finished;
};

struct worker {
	struct gate *gate;
	struct measurement result;
};

static uint64_t now_ns(void)
{
	struct timespec now;

	if (clock_gettime(CLOCK_MONOTONIC, &now))
		test_perror("benchmark clock_gettime");
	return (uint64_t)now.tv_sec * UINT64_C(1000000000) + now.tv_nsec;
}

static unsigned char *map_page(void)
{
	unsigned char *mapping = mmap(NULL, page_size, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

	if (mapping == MAP_FAILED)
		test_perror("benchmark mmap");
	return mapping;
}

static void unmap_page(unsigned char *mapping)
{
	if (munmap(mapping, page_size))
		test_perror("benchmark munmap");
}

static void check_and_mark(unsigned char *mapping)
{
	if ((uintptr_t)mapping % page_size || mapping[0] || mapping[page_size - 1])
		test_fail("benchmark mapping alignment or zero-fill");
	mapping[0] = 0x5a;
	mapping[page_size - 1] = 0xa5;
}

static void check_marker(unsigned char *mapping)
{
	if (mapping[0] != 0x5a || mapping[page_size - 1] != 0xa5)
		test_fail("benchmark live mapping was overwritten");
}

static void report(const char *scenario, size_t resident, unsigned holes,
	unsigned threads, unsigned sample, struct measurement result,
	uint64_t elapsed)
{
	/* Totals allow consumers to aggregate without rounding per-operation times. */
	printf("mmap-bench,%s,%zu,%u,%u,%u,%zu,%" PRIu64 ",%" PRIu64 ",%" PRIu64 "\n",
		scenario, resident, holes, threads, sample, result.operations,
		result.mmap_ns, result.munmap_ns, elapsed);
	fflush(stdout);
}

static void scale(size_t count, unsigned sample)
{
	unsigned char *mappings[max_mappings];
	uint64_t begin = now_ns(), mapped, before_unmap, end;

	for (size_t i = 0; i < count; i++)
		mappings[i] = map_page();
	mapped = now_ns();
	for (size_t i = 0; i < count; i++)
		check_and_mark(mappings[i]);
	before_unmap = now_ns();
	/* FIFO release exposes removal cost at the tail of the mapping list. */
	for (size_t i = 0; i < count; i++)
		unmap_page(mappings[i]);
	end = now_ns();
	if (sample)
		report("scale", count, 0, 1, sample,
			(struct measurement){ mapped - begin, end - before_unmap, count },
			end - begin);
}

static void fragment(size_t count, unsigned holes, unsigned sample)
{
	unsigned char *mappings[max_mappings];
	size_t stride = holes ? 100 / holes : 0, removed = 0;
	uint64_t begin, unmapped, before_mmap, end;

	for (size_t i = 0; i < count; i++) {
		mappings[i] = map_page();
		check_and_mark(mappings[i]);
	}
	begin = now_ns();
	for (size_t i = 0; stride && i < count; i += stride) {
		unmap_page(mappings[i]);
		mappings[i] = NULL;
		removed++;
	}
	unmapped = now_ns();
	/* Check retained mappings outside the allocation/release timing spans. */
	for (size_t i = 0; i < count; i++)
		if (mappings[i])
			check_marker(mappings[i]);
	before_mmap = now_ns();
	for (size_t i = 0; stride && i < count; i += stride)
		mappings[i] = map_page();
	end = now_ns();
	for (size_t i = 0; i < count; i++) {
		if (stride && i % stride == 0)
			check_and_mark(mappings[i]);
		else
			check_marker(mappings[i]);
		unmap_page(mappings[i]);
	}
	if (sample)
		report("fragment", count, holes, 1, sample,
			(struct measurement){ removed ? end - before_mmap : 0,
				removed ? unmapped - begin : 0, removed },
			end - begin);
}

static void *run_worker(void *opaque)
{
	struct worker *worker = opaque;
	unsigned char *mappings[batch_size];

	atomic_fetch_add_explicit(&worker->gate->ready, 1, memory_order_release);
	while (!atomic_load_explicit(&worker->gate->start, memory_order_acquire))
		sched_yield();
	for (unsigned round = 0; round < iterations; round++) {
		uint64_t begin = now_ns();

		for (size_t i = 0; i < batch_size; i++)
			mappings[i] = map_page();
		worker->result.mmap_ns += now_ns() - begin;
		for (size_t i = 0; i < batch_size; i++)
			check_and_mark(mappings[i]);
		begin = now_ns();
		for (size_t i = 0; i < batch_size; i++)
			unmap_page(mappings[i]);
		worker->result.munmap_ns += now_ns() - begin;
		worker->result.operations += batch_size;
	}
	atomic_fetch_add_explicit(&worker->gate->finished, 1, memory_order_release);
	return NULL;
}

static void concurrent(size_t resident, unsigned threads, unsigned sample)
{
	unsigned char *mappings[max_mappings];
	pthread_t tids[max_threads];
	struct gate gate = { 0 };
	struct worker workers[max_threads] = { 0 };
	struct measurement total = { 0 };
	uint64_t begin, end;

	for (size_t i = 0; i < resident; i++) {
		mappings[i] = map_page();
		check_and_mark(mappings[i]);
	}
	for (unsigned i = 0; i < threads; i++) {
		workers[i].gate = &gate;
		int error = pthread_create(&tids[i], NULL, run_worker, &workers[i]);
		if (error) {
			errno = error;
			test_perror("benchmark pthread_create");
		}
	}
	while (atomic_load_explicit(&gate.ready, memory_order_acquire) != (int)threads)
		sched_yield();
	begin = now_ns();
	atomic_store_explicit(&gate.start, 1, memory_order_release);
	while (atomic_load_explicit(&gate.finished, memory_order_acquire) != (int)threads)
		sched_yield();
	end = now_ns();
	for (unsigned i = 0; i < threads; i++) {
		int error = pthread_join(tids[i], NULL);
		if (error) {
			errno = error;
			test_perror("benchmark pthread_join");
		}
		total.mmap_ns += workers[i].result.mmap_ns;
		total.munmap_ns += workers[i].result.munmap_ns;
		total.operations += workers[i].result.operations;
	}
	for (size_t i = 0; i < resident; i++) {
		check_marker(mappings[i]);
		unmap_page(mappings[i]);
	}
	if (sample)
		report("concurrent", resident, 0, threads, sample, total, end - begin);
}

int main(void)
{
	const size_t counts[] = { 16, 64, 256 };
	long size = sysconf(_SC_PAGESIZE);

	if (size <= 0)
		test_fail("benchmark invalid page size");
	page_size = (size_t)size;
	printf("mmap-bench-config: pointer_bits=%zu page_bytes=%zu samples=%u batch=%u iterations=%u\n",
		sizeof(void *) * 8, page_size, samples, batch_size, iterations);
	puts("mmap-bench,scenario,resident,holes_percent,threads,sample,operations_per_kind,mmap_ns,munmap_ns,elapsed_ns");
	for (size_t i = 0; i < sizeof(counts) / sizeof(counts[0]); i++)
		for (unsigned sample = 0; sample <= samples; sample++)
			scale(counts[i], sample);
	for (size_t count = 64; count <= max_mappings; count *= 4)
		for (unsigned holes = 0; holes <= 50; holes += 25)
			for (unsigned sample = 0; sample <= samples; sample++)
				fragment(count, holes, sample);
	for (size_t count = 16; count <= max_mappings; count *= 16)
		for (unsigned threads = 1; threads <= max_threads; threads *= 2)
			for (unsigned sample = 0; sample <= samples; sample++)
				concurrent(count, threads, sample);
	test_pass();
}
