/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include "mmap-vfs-stats.h"
#include <fcntl.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

extern long __wasm_mmap_init_v1(size_t, size_t);

static long mapping(int fd, size_t page)
{
	return syscall(255, (unsigned long)fd, (unsigned long)page, 0UL, 0UL);
}

int main(void)
{
	mmap_stats_start();
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected EROFS error fixture page size");
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY)
		test_perror("mount devtmpfs");
	if (mkdir("/snapshot", 0755) ||
	    mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL))
		test_perror("mount error snapshot");
	int bad = open("/snapshot/bad", O_RDONLY);
	int good = open("/snapshot/good", O_RDONLY);
	if (bad < 0 || good < 0) test_perror("open error snapshot files");
	struct stat stat;
	if (fstat(bad, &stat) || !S_ISREG(stat.st_mode) || stat.st_size != (off_t)page)
		test_fail("invalid readable metadata for bad file");
	if (syscall(256, (unsigned long)bad) != 1) test_fail("bad source not a snapshot");
	if (lseek(bad, 23, SEEK_SET) != 23) test_perror("set bad source position");
	unsigned char *sentinel = mmap(0, page, PROT_READ | PROT_WRITE,
		MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (sentinel == MAP_FAILED) test_perror("error sentinel mmap");
	memset(sentinel, 0x5a, page);
	for (int round = 0; round < 8; round++) {
		errno = 0;
		if (mapping(bad, page) != -1 || errno != EIO)
			test_fail("real EROFS read error did not propagate as EIO");
		mmap_stats_expect(0, 0, 0);
		if (__wasm_mmap_init_v1(page, 0) != -EPERM)
			test_fail("failed real read retained copy authorization");
		if (lseek(bad, 0, SEEK_CUR) != 23) test_fail("failed read changed file position");
		for (size_t i = 0; i < page; i++)
			if (sentinel[i] != 0x5a) test_fail("failed read damaged live mapping");
		long result = mapping(good, page);
		if (result == -1) test_perror("healthy read after real EIO");
		unsigned char *bytes = (void *)(uintptr_t)result;
		for (size_t i = 0; i < page; i++)
			if (bytes[i] != (unsigned char)(i * 37 + 11))
				test_fail("healthy content after real EIO mismatch");
		if (munmap(bytes, page)) test_perror("healthy recovery unmap");
		mmap_stats_expect(0, 0, 0);
	}
	unsigned char byte;
	errno = 0;
	if (pread(bad, &byte, 1, 0) != -1 || errno != EIO)
		test_fail("ordinary pread did not observe bad file EIO");
	if (close(bad) || close(good) || umount("/snapshot") || munmap(sentinel, page))
		test_perror("error snapshot cleanup");
	mmap_stats_wait(0, 0, 0);
	test_pass();
}
