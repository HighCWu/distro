/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define ITERATIONS 64
#ifdef FILE_COPY_COMPONENTS
#define TRIALS 6
#define BACKENDS 3
#define RECORD "file-copy-components"
#define COMPLETED "file mmap: warm three-path diagnostic completed; no speed threshold"
static const int backend_order[TRIALS][BACKENDS] = {
	{0, 1, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}, {1, 0, 2}, {0, 2, 1}
};
#else
#define TRIALS 5
#define BACKENDS 2
#define RECORD "file-copy-bench"
#define COMPLETED "file mmap: warm paired copy benchmark completed; no speed threshold"
#endif

static uint64_t now_ns(void)
{
	struct timespec value;
	if (clock_gettime(CLOCK_MONOTONIC, &value)) test_perror("file benchmark clock");
	return (uint64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}

static unsigned char *acquire(int fd, size_t length, int mapping)
{
	if (mapping == 1) {
		void *bytes = mmap(NULL, length, PROT_READ, MAP_PRIVATE, fd, 0);
		if (bytes == MAP_FAILED) test_perror("file benchmark mmap");
		return bytes;
	}
	/* Diagnostic backend 2 uses ordinary anonymous mmap, then exactly the
	 * same pread loop as malloc. It is not initialized unpublished backing
	 * and cannot isolate a pure allocator or kernel cost by subtraction. */
	unsigned char *bytes = mapping == 2 ?
		mmap(NULL, length, PROT_READ | PROT_WRITE,
		     MAP_PRIVATE | MAP_ANONYMOUS, -1, 0) : malloc(length);
	if (bytes == MAP_FAILED) test_perror("file benchmark anonymous mmap");
	if (!bytes) test_perror("file benchmark malloc");
	size_t done = 0;
	while (done < length) {
		ssize_t count = pread(fd, bytes + done, length - done, (off_t)done);
		if (count < 0 && errno == EINTR) continue;
		if (count <= 0) test_fail("file benchmark incomplete pread");
		done += (size_t)count;
	}
	return bytes;
}

static void release(unsigned char *bytes, size_t length, int mapping)
{
	if (mapping) {
		if (munmap(bytes, length)) test_perror("file benchmark munmap");
	} else free(bytes);
}

static uint64_t sample(const unsigned char *bytes, size_t length)
{
	uint64_t value = bytes[length - 1];
	for (size_t i = 0; i < length; i += 4096) value += bytes[i];
	return value;
}

static void benchmark(int fd)
{
	/* Warm VFS/allocation paths and validate every byte OUTSIDE timing. The
	 * measured round includes allocation, read/copy, sparse consumption and
	 * release. It is not zero-copy, cold-cache or pure kernel latency. */
	for (size_t length = 65536; length <= 131072; length *= 2) {
		uint64_t expected = 0;
		for (int mapping = 0; mapping < BACKENDS; mapping++) {
			unsigned char *bytes = acquire(fd, length, mapping);
			for (size_t i = 0; i < length; i++)
				if (bytes[i] != (unsigned char)(i * 37 + 11))
					test_fail("file benchmark initial content mismatch");
			expected = sample(bytes, length) * ITERATIONS;
			release(bytes, length, mapping);
		}
		for (unsigned int trial = 1; trial <= TRIALS; trial++) {
			for (int position = 0; position < BACKENDS; position++) {
#ifdef FILE_COPY_COMPONENTS
				/* All six permutations: each backend occupies each position
				 * twice, with both relative orders of every pair balanced. */
				int mapping = backend_order[trial - 1][position];
#else
				/* Alternate the original paired baseline without changing it. */
				int mapping = (trial + position) & 1;
#endif
				uint64_t checksum = 0, start = now_ns();
				for (unsigned int i = 0; i < ITERATIONS; i++) {
					unsigned char *bytes = acquire(fd, length, mapping);
					checksum += sample(bytes, length);
					release(bytes, length, mapping);
				}
				uint64_t elapsed = now_ns() - start;
				if (!elapsed || checksum != expected) test_fail("file benchmark invalid sample");
				printf(RECORD ",%zu,%s,%zu,%u,%u,%" PRIu64 ",%" PRIu64 "\n",
					sizeof(void *) * 8, mapping == 2 ? "anon-pread" : mapping ? "mmap" : "pread", length,
					trial, ITERATIONS, elapsed, checksum);
			}
		}
	}
	if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("file benchmark changed fd position");
}

int main(void)
{
	if (sysconf(_SC_PAGESIZE) != 65536) test_fail("unexpected file benchmark page size");
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("file benchmark mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY)
		test_perror("file benchmark devtmpfs");
	if (mkdir("/snapshot", 0755) || mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL))
		test_perror("file benchmark snapshot");
	int fd = open("/snapshot/pattern", O_RDONLY);
	if (fd < 0 || lseek(fd, 23, SEEK_SET) != 23) test_perror("file benchmark source");
	benchmark(fd);
	if (close(fd) || umount("/snapshot")) test_perror("file benchmark source cleanup");
	puts(COMPLETED);
	test_pass();
}
