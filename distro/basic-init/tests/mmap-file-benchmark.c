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
#define TRIALS 5

static uint64_t now_ns(void)
{
	struct timespec value;
	if (clock_gettime(CLOCK_MONOTONIC, &value)) test_perror("file benchmark clock");
	return (uint64_t)value.tv_sec * 1000000000 + value.tv_nsec;
}

static unsigned char *acquire(int fd, size_t length, int mapping)
{
	if (mapping) {
		void *bytes = mmap(NULL, length, PROT_READ, MAP_PRIVATE, fd, 0);
		if (bytes == MAP_FAILED) test_perror("file benchmark mmap");
		return bytes;
	}
	unsigned char *bytes = malloc(length);
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
		for (int mapping = 0; mapping <= 1; mapping++) {
			unsigned char *bytes = acquire(fd, length, mapping);
			for (size_t i = 0; i < length; i++)
				if (bytes[i] != (unsigned char)(i * 37 + 11))
					test_fail("file benchmark initial content mismatch");
			expected = sample(bytes, length) * ITERATIONS;
			release(bytes, length, mapping);
		}
		for (unsigned int trial = 1; trial <= TRIALS; trial++) {
			/* Alternate which backend runs first to reduce order bias. */
			for (int position = 0; position < 2; position++) {
				int mapping = (trial + position) & 1;
				uint64_t checksum = 0, start = now_ns();
				for (unsigned int i = 0; i < ITERATIONS; i++) {
					unsigned char *bytes = acquire(fd, length, mapping);
					checksum += sample(bytes, length);
					release(bytes, length, mapping);
				}
				uint64_t elapsed = now_ns() - start;
				if (!elapsed || checksum != expected) test_fail("file benchmark invalid sample");
				printf("file-copy-bench,%zu,%s,%zu,%u,%u,%" PRIu64 ",%" PRIu64 "\n",
					sizeof(void *) * 8, mapping ? "mmap" : "pread", length,
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
	puts("file mmap: warm paired copy benchmark completed; no speed threshold");
	test_pass();
}
