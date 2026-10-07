/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

/* Private test-kernel slot; not mmap UAPI or an SDK interface. */
#define FILE_READ_TEST_NR 255

static long read_mapping(int fd, size_t length, uint64_t offset)
{
	return syscall(FILE_READ_TEST_NR, (unsigned long)fd, (unsigned long)length,
		(unsigned long)(uint32_t)offset, (unsigned long)(uint32_t)(offset >> 32));
}

static void rejected(int fd, size_t length, uint64_t offset, int expected)
{
	errno = 0;
	if (read_mapping(fd, length, offset) != -1 || errno != expected)
		test_fail("EROFS test mapping refusal mismatch");
}

static unsigned char *mapped(int fd, size_t length, uint64_t offset)
{
	long result = read_mapping(fd, length, offset);
	if (result == -1) test_perror("EROFS test mapping");
	return (void *)(uintptr_t)result;
}

static void check_bytes(const unsigned char *bytes, size_t rounded,
			size_t offset, size_t source_size)
{
	for (size_t i = 0; i < rounded; i++) {
		unsigned char expected = offset + i < source_size ?
			(unsigned char)((offset + i) * 37 + 11) : 0;
		if (bytes[i] != expected) test_fail("EROFS content or zero tail mismatch");
	}
}

int main(void)
{
	size_t page = (size_t)sysconf(_SC_PAGESIZE);
	if (page != 65536) test_fail("unexpected EROFS test page size");
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY)
		test_perror("mount devtmpfs");
	if (mkdir("/snapshot", 0755) || mkdir("/ordinary", 0755)) test_perror("mkdir mounts");
	if (mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL) ||
	    mount("/dev/vdb", "/ordinary", "erofs", MS_RDONLY, NULL)) test_perror("mount EROFS");
	int fd = open("/snapshot/pattern", O_RDONLY);
	int ordinary = open("/ordinary/pattern", O_RDONLY);
	int empty = open("/snapshot/empty", O_RDONLY);
	int directory = open("/snapshot", O_RDONLY | O_DIRECTORY);
	int path = open("/snapshot/pattern", O_PATH);
	int init = open("/init", O_RDONLY);
	if (fd < 0 || ordinary < 0 || empty < 0 || directory < 0 || path < 0 || init < 0)
		test_perror("open EROFS fixtures");
	for (int i = 0; i < 8; i++) {
		rejected(ordinary, page, 0, EOPNOTSUPP);
		rejected(init, page, 0, EOPNOTSUPP);
		rejected(directory, page, 0, EOPNOTSUPP);
		rejected(path, page, 0, EBADF);
		rejected(empty, page, 0, EINVAL);
	}
	rejected(-1, page, 0, EBADF);
	rejected(fd, 0, 0, EINVAL);
	rejected(fd, 2 * page + 1, 0, EINVAL);
	rejected(fd, page, 1, EINVAL);
	rejected(fd, page, UINT64_C(1) << 32, EINVAL);
	rejected(fd, page, UINT64_C(1) << 63, EINVAL);
	rejected(fd, 2 * page, 2 * page, EINVAL);
	rejected(fd, page, 3 * page, EINVAL);
	/* Standard mmap must stay closed even for the verified source. */
	errno = 0;
	if (mmap(0, page, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0) != MAP_FAILED ||
	    errno != EINVAL) test_fail("standard file mmap was opened by a fixture");
	if (lseek(fd, 23, SEEK_SET) != 23) test_perror("set EROFS file position");
	unsigned char *full = mapped(fd, 2 * page, page);
	unsigned char *tail = mapped(fd, 1, 2 * page);
	if (lseek(fd, 0, SEEK_CUR) != 23) test_fail("mapping read changed EROFS file position");
	check_bytes(full, 2 * page, page, 2 * page + 7);
	check_bytes(tail, page, 2 * page, 2 * page + 7);
	full[0] ^= 0xff;
	if (tail[0] != 11) test_fail("independent EROFS copy modified");
	unsigned char *fresh = mapped(fd, page, page);
	check_bytes(fresh, page, page, 2 * page + 7);
	unsigned char original;
	if (pread(fd, &original, 1, page) != 1 || original != 11)
		test_fail("private copy wrote back to EROFS source");
	full[0] ^= 0xff;
	if (close(fd)) test_perror("close EROFS source");
	int replacement = open("/ordinary/pattern", O_RDONLY);
	if (replacement != fd) test_fail("EROFS source fd was not reused");
	rejected(replacement, page, 0, EOPNOTSUPP);
	if (close(replacement) || close(ordinary) || close(empty) || close(directory) ||
	    close(path) || close(init)) test_perror("close EROFS fixtures");
	if (umount("/snapshot") || umount("/ordinary")) test_perror("unmount EROFS fixtures");
	/* Published copies have no dependency on fd numbers or the mounted source. */
	check_bytes(full, 2 * page, page, 2 * page + 7);
	check_bytes(tail, page, 2 * page, 2 * page + 7);
	check_bytes(fresh, page, page, 2 * page + 7);
	if (munmap(full, 2 * page) || munmap(tail, page) || munmap(fresh, page))
		test_perror("unmap EROFS private copies");
	test_pass();
}
