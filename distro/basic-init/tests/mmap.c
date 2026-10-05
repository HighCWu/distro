#define _GNU_SOURCE
#include "test.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

enum {
	stress_threads = 4,
	stress_iterations = 32,
	fixed_race_threads = 8,
	fragmentation_iterations = 16,
};

struct fixed_race {
	_Atomic int start;
	unsigned char *target;
	size_t page_size;
};

static void expect_failure(long result, int expected_errno, const char *message)
{
	if (result != -1 || errno != expected_errno)
		test_fail(message);
}

static void *stress_mmap(void *argument)
{
	uintptr_t worker = (uintptr_t)argument;
	size_t page_size = (size_t)sysconf(_SC_PAGESIZE);

	for (size_t iteration = 0; iteration < stress_iterations; iteration++) {
		size_t pages = 3 + ((worker + iteration) & 1);
		size_t length = pages * page_size;
		unsigned char expected = (unsigned char)(1 + worker + iteration);
		unsigned char *mapping;
		unsigned char *fresh;

		mapping = mmap(0, length, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (mapping == MAP_FAILED)
			return "concurrent mmap failed";
		for (size_t page = 0; page < pages; page++) {
			if (mapping[page * page_size] != 0 ||
			    mapping[(page + 1) * page_size - 1] != 0)
				return "concurrent mmap was not zero filled";
			mapping[page * page_size] = expected;
			mapping[(page + 1) * page_size - 1] = expected;
		}
		if (munmap(mapping + page_size, page_size))
			return "concurrent partial munmap failed";
		if (munmap(mapping, page_size))
			return "concurrent prefix munmap failed";
		if (munmap(mapping + 2 * page_size, (pages - 2) * page_size))
			return "concurrent suffix munmap failed";

		fresh = mmap(0, page_size, PROT_READ | PROT_WRITE,
			     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (fresh == MAP_FAILED)
			return "mmap after fragmented munmap failed";
		if (fresh[0] != 0 || fresh[page_size - 1] != 0)
			return "reallocated mmap was not zero filled";
		if (munmap(fresh, page_size))
			return "reallocated munmap failed";
	}

	return NULL;
}

static void *race_fixed_noreplace(void *argument)
{
	struct fixed_race *race = argument;
	void *mapping;

	while (!atomic_load_explicit(&race->start, memory_order_acquire))
		sched_yield();
	errno = 0;
	mapping = mmap(race->target, race->page_size,
		       PROT_READ | PROT_WRITE,
		       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
		       -1, 0);
	if (mapping == MAP_FAILED)
		return errno == EEXIST ? NULL : "fixed race returned wrong error";
	return mapping;
}

static void stress_fragmentation(size_t page_size)
{
	for (size_t iteration = 0; iteration < fragmentation_iterations;
	     iteration++) {
		unsigned char *mapping;

		mapping = mmap(0, 8 * page_size, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
		if (mapping == MAP_FAILED)
			test_perror("fragmentation mmap");
		for (size_t page = 0; page < 8; page += 2) {
			mapping[page * page_size] = 0x6d;
			if (munmap(mapping + page * page_size, page_size))
				test_perror("fragmentation munmap");
		}
		for (size_t page = 0; page < 8; page += 2) {
			unsigned char *refill;

			refill = mmap(mapping + page * page_size, page_size,
				      PROT_READ | PROT_WRITE,
				      MAP_PRIVATE | MAP_ANONYMOUS |
				      MAP_FIXED_NOREPLACE, -1, 0);
			if (refill == MAP_FAILED)
				test_perror("fragmentation refill mmap");
			if (refill != mapping + page * page_size)
				test_fail("fragmentation refill moved");
			if (refill[0] || refill[page_size - 1])
				test_fail("fragmentation refill was not zero filled");
		}
		if (munmap(mapping, 8 * page_size))
			test_perror("fragmentation cleanup");
	}
}

int main(void)
{
	size_t page_size = (size_t)sysconf(_SC_PAGESIZE);
	size_t length = 3 * page_size;
	struct fixed_race race = { 0 };
	pthread_t race_threads[fixed_race_threads];
	pthread_t threads[stress_threads];
	unsigned char *arena;
	unsigned char *fallback;
	unsigned char *fixed;
	unsigned char *hint_owner;
	unsigned char *hinted;
	unsigned char *mapping;
	unsigned char *neighbor;
	unsigned char *raw;

	if (page_size == (size_t)-1 || !page_size || (page_size & (page_size - 1)))
		test_perror("sysconf(_SC_PAGESIZE)");

	mapping = mmap(0, page_size, PROT_READ | PROT_WRITE,
		       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (mapping == MAP_FAILED)
		test_perror("mmap");
	if ((uintptr_t)mapping & (page_size - 1))
		test_fail("libc mmap result is not page aligned");
	for (size_t i = 0; i < page_size; i++)
		if (mapping[i])
			test_fail("libc mmap result is not zero filled");
	mapping[0] = 0x5a;
	mapping[page_size - 1] = 0xa5;
	if (munmap(mapping, page_size))
		test_perror("munmap");

	raw = (void *)syscall(SYS_mmap, 0, length, PROT_READ | PROT_WRITE,
			      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (raw == MAP_FAILED)
		test_perror("raw SYS_mmap");
	if ((uintptr_t)raw & (page_size - 1))
		test_fail("raw SYS_mmap result is not page aligned");
	for (size_t i = 0; i < length; i++)
		if (raw[i])
			test_fail("raw SYS_mmap result is not zero filled");
	raw[0] = 0x11;
	raw[page_size] = 0x22;
	raw[length - 1] = 0x33;

	if (syscall(SYS_munmap, raw + page_size, page_size))
		test_perror("raw partial SYS_munmap");
	if (munmap(raw, page_size))
		test_perror("partial munmap prefix");
	if (syscall(SYS_munmap, raw + 2 * page_size, page_size))
		test_perror("raw partial SYS_munmap suffix");

	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, page_size, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0),
		       ENOMEM, "MAP_FIXED did not fail with ENOMEM");
	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, page_size, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
			       -1, 0),
		       ENOMEM, "MAP_FIXED_NOREPLACE did not fail with ENOMEM");
	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, page_size, PROT_READ,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0),
		       EINVAL, "unsupported protection did not fail with EINVAL");
	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, 0, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0),
		       EINVAL, "zero-length mapping did not fail with EINVAL");
	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, (size_t)-1,
			       PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0),
		       ENOMEM, "overflowing mapping did not fail with ENOMEM");
	errno = 0;
	expect_failure(syscall(SYS_munmap, raw + 1, page_size), EINVAL,
		       "unaligned munmap did not fail with EINVAL");

	mapping = mmap((void *)(16 * page_size), page_size,
		       PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS,
		       -1, 0);
	if (mapping == MAP_FAILED)
		test_perror("advisory-address mmap");
	if (munmap(mapping, page_size))
		test_perror("advisory-address munmap");

	hint_owner = mmap(0, 3 * page_size, PROT_READ | PROT_WRITE,
			  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (hint_owner == MAP_FAILED)
		test_perror("hint backing mmap");
	hint_owner[page_size] = 0x7b;
	if (munmap(hint_owner + page_size, page_size))
		test_perror("hint hole munmap");
	hinted = mmap(hint_owner + page_size + 17, page_size,
		      PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS,
		      -1, 0);
	if (hinted == MAP_FAILED)
		test_perror("free address hint mmap");
	if (hinted != hint_owner + page_size)
		test_fail("free address hint was not adopted");
	if (hinted[0] || hinted[page_size - 1])
		test_fail("hinted mmap was not zero filled");
	hinted[0] = 0x4d;

	fallback = mmap(hint_owner, page_size, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (fallback == MAP_FAILED)
		test_perror("conflicting address hint mmap");
	if (fallback == hint_owner)
		test_fail("conflicting address hint replaced a live mapping");
	if (munmap(fallback, page_size) || munmap(hinted, page_size))
		test_perror("address hint cleanup");

	fixed = mmap(hint_owner + page_size, page_size,
		     PROT_READ | PROT_WRITE,
		     MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
		     -1, 0);
	if (fixed == MAP_FAILED)
		test_perror("MAP_FIXED_NOREPLACE free hole");
	if (fixed != hint_owner + page_size)
		test_fail("MAP_FIXED_NOREPLACE did not use the exact address");
	if (fixed[0] || fixed[page_size - 1])
		test_fail("MAP_FIXED_NOREPLACE mapping was not zero filled");

	errno = 0;
	expect_failure((long)mmap(hint_owner, page_size, PROT_READ | PROT_WRITE,
			    MAP_PRIVATE | MAP_ANONYMOUS |
			    MAP_FIXED_NOREPLACE, -1, 0),
		       EEXIST, "MAP_FIXED_NOREPLACE conflict did not fail");
	errno = 0;
	expect_failure((long)mmap(hint_owner + 1, page_size,
			    PROT_READ | PROT_WRITE,
			    MAP_PRIVATE | MAP_ANONYMOUS |
			    MAP_FIXED_NOREPLACE, -1, 0),
		       EINVAL, "unaligned MAP_FIXED_NOREPLACE did not fail");
	errno = 0;
	expect_failure((long)mmap((void *)(uintptr_t)-page_size, page_size,
			    PROT_READ | PROT_WRITE,
			    MAP_PRIVATE | MAP_ANONYMOUS |
			    MAP_FIXED_NOREPLACE, -1, 0),
		       ENOMEM, "unreserved MAP_FIXED_NOREPLACE did not fail");

	if (munmap(fixed, page_size) || munmap(hint_owner, page_size) ||
	    munmap(hint_owner + 2 * page_size, page_size))
		test_perror("MAP_FIXED_NOREPLACE cleanup");

	arena = mmap(0, page_size, PROT_READ | PROT_WRITE,
		     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (arena == MAP_FAILED)
		test_perror("direct arena mmap");
	neighbor = mmap(0, page_size, PROT_READ | PROT_WRITE,
			MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (neighbor == MAP_FAILED)
		test_perror("direct arena neighbor mmap");
	if (neighbor != arena + page_size)
		test_fail("ordinary mmap did not reuse reserved direct arena");
	fixed = mmap(arena + 3 * page_size, page_size,
		     PROT_READ | PROT_WRITE,
		     MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,
		     -1, 0);
	if (fixed == MAP_FAILED)
		test_perror("reserved direct arena MAP_FIXED_NOREPLACE");
	if (fixed != arena + 3 * page_size)
		test_fail("reserved direct arena exact mapping moved");
	if (fixed[0] || fixed[page_size - 1])
		test_fail("reserved direct arena mapping was not zero filled");
	if (munmap(fixed, page_size) || munmap(neighbor, page_size) ||
	    munmap(arena, page_size))
		test_perror("direct arena cleanup");

	stress_fragmentation(page_size);

	for (size_t i = 0; i < fixed_race_threads; i++)
		if (pthread_create(&race_threads[i], NULL, race_fixed_noreplace,
				   &race) != 0)
			test_fail("fixed race pthread_create failed");
	hint_owner = mmap(0, 3 * page_size, PROT_READ | PROT_WRITE,
			  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (hint_owner == MAP_FAILED)
		test_perror("fixed race backing mmap");
	if (munmap(hint_owner + page_size, page_size))
		test_perror("fixed race hole munmap");
	race.target = hint_owner + page_size;
	race.page_size = page_size;
	atomic_store_explicit(&race.start, 1, memory_order_release);
	{
		size_t winners = 0;

		for (size_t i = 0; i < fixed_race_threads; i++) {
			void *result;

			if (pthread_join(race_threads[i], &result) != 0)
				test_fail("fixed race pthread_join failed");
			if (result == race.target)
				winners++;
			else if (result)
				test_fail(result);
		}
		if (winners != 1)
			test_fail("fixed race did not have exactly one winner");
	}
	if (munmap(race.target, page_size) ||
	    munmap(hint_owner, page_size) ||
	    munmap(hint_owner + 2 * page_size, page_size))
		test_perror("fixed race cleanup");

	for (uintptr_t i = 0; i < stress_threads; i++)
		if (pthread_create(&threads[i], NULL, stress_mmap,
				   (void *)i) != 0)
			test_fail("mmap stress pthread_create failed");
	for (size_t i = 0; i < stress_threads; i++) {
		void *result;

		if (pthread_join(threads[i], &result) != 0)
			test_fail("mmap stress pthread_join failed");
		if (result)
			test_fail(result);
	}

	test_pass();
}
