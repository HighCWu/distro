/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/uio.h>
#include <unistd.h>

enum { PAGE = 65536, CHUNK = 2 * PAGE };
static void fail(const char *what)
{
	printf("::vm-test::fail: direct I/O: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)

static void check_block_device(unsigned char *source, unsigned char *destination)
{
	/* Only the independently supplied, unformatted test disk may be written.
	 * Refuse the mounted root device, any other size, or nonzero initial data. */
	struct stat root, device;
	int fd = open("/dev/vdb", O_RDWR | O_DIRECT);
	CHECK(fd >= 0, "open separate blank disk");
	CHECK(!stat("/", &root) && !fstat(fd, &device) && S_ISBLK(device.st_mode) &&
	      device.st_rdev != root.st_dev, "scratch disk is not mounted root");
	const off_t disk_size = 8 * 1024 * 1024;
	CHECK(lseek(fd, 0, SEEK_END) == disk_size, "exact scratch disk size");
	CHECK(pread(fd, destination, CHUNK, 0) == CHUNK, "read blank raw disk");
	for (size_t i = 0; i < CHUNK; i++) CHECK(destination[i] == 0, "scratch prefix initially zero");
	CHECK(pwrite(fd, source, CHUNK, PAGE) == CHUNK, "direct raw write");
	CHECK(pread(fd, destination, CHUNK, PAGE) == CHUNK &&
	      !memcmp(source, destination, CHUNK), "raw positional contents");
	CHECK(lseek(fd, 0, SEEK_CUR) == disk_size, "raw positional calls preserve offset");
	struct iovec output[] = {{source + 2 * PAGE, PAGE}, {source + PAGE, PAGE}, {source, PAGE}};
	CHECK(pwritev(fd, output, 3, 4 * PAGE) == CHUNK, "raw bounded vector write");
	CHECK(pread(fd, destination, CHUNK, 4 * PAGE) == CHUNK &&
	      !memcmp(destination, source + 2 * PAGE, PAGE) &&
	      !memcmp(destination + PAGE, source + PAGE, PAGE), "raw vector ordering");
	errno = 0;
	CHECK(pwrite(fd, source, 3 * PAGE + 1, 4 * PAGE) == -1 && errno == EINVAL,
	      "raw full-length alignment preserved before chunking");
	errno = 0;
	CHECK(pread(fd, destination, PAGE, PAGE + 1) == -1 && errno == EINVAL,
	      "raw sector offset alignment");
	void *volatile bad = NULL;
	errno = 0;
	CHECK(pwrite(fd, bad, PAGE, 4 * PAGE) == -1 && errno == EFAULT, "raw bad source");
	CHECK(pread(fd, destination, PAGE, disk_size) == 0, "raw read at device end");
	CHECK(pread(fd, destination, PAGE, disk_size + 1) == 0, "raw read beyond device end");
	errno = 0;
	CHECK(pwrite(fd, source, PAGE, disk_size) == -1 && errno == ENOSPC, "raw write at device end");
	CHECK(pread(fd, destination, PAGE, 4 * PAGE) == PAGE &&
	      !memcmp(destination, source + 2 * PAGE, PAGE), "raw recovery without failed-write mutation");
	CHECK(pwrite(fd, source, 3 * PAGE + 1, disk_size - PAGE) == PAGE,
	      "raw end clipping precedes alignment of the unused tail");
	CHECK(pread(fd, destination, PAGE, disk_size - PAGE) == PAGE &&
	      !memcmp(destination, source, PAGE), "raw clipped prefix contents");
	CHECK(!fsync(fd) && !close(fd), "flush and close scratch disk");
	puts("direct I/O: separate raw block disk, vectors, alignment, device end and recovery pass");
}

int main(void)
{
	unsigned char *source, *destination;
	CHECK(!posix_memalign((void **)&source, PAGE, 4 * PAGE), "aligned source");
	CHECK(!posix_memalign((void **)&destination, PAGE, 4 * PAGE), "aligned destination");
	for (size_t i = 0; i < 4 * PAGE; i++) source[i] = (unsigned char)(i * 29 + i / PAGE);
	memset(destination, 0, 4 * PAGE);
	int fd = open("/direct-io-data", O_CREAT | O_EXCL | O_RDWR | O_DIRECT, 0600);
	CHECK(fd >= 0, "open ordinary direct file");
	struct statfs filesystem;
	CHECK(!fstatfs(fd, &filesystem) && filesystem.f_type == 0xef53, "actual ext4 root");
	CHECK((fcntl(fd, F_GETFL) & O_DIRECT) != 0, "retain direct flag");
	CHECK(write(fd, source, CHUNK) == CHUNK, "direct scalar write");
	CHECK(pread(fd, destination, CHUNK, 0) == CHUNK, "direct scalar pread");
	CHECK(!memcmp(source, destination, CHUNK), "direct retained contents");
	CHECK(lseek(fd, 0, SEEK_CUR) == CHUNK, "pread preserves fd position");
	puts("direct I/O: ext4 aligned scalar writes and positional reads pass");

	struct iovec output[] = {{source + 2 * PAGE, PAGE}, {source + PAGE, PAGE}, {source, PAGE}};
	CHECK(pwritev(fd, output, 3, 0) == CHUNK, "bounded vectored short write");
	CHECK(lseek(fd, 0, SEEK_SET) == 0, "rewind vector read");
	struct iovec input[] = {{destination, PAGE}, {destination + PAGE, PAGE}};
	CHECK(readv(fd, input, 2) == CHUNK, "direct readv");
	CHECK(!memcmp(destination, source + 2 * PAGE, PAGE) &&
	      !memcmp(destination + PAGE, source + PAGE, PAGE), "vector ordering and partial extent");
	CHECK(!fsync(fd), "sync direct file");
	int buffered = open("/direct-io-data", O_RDONLY);
	CHECK(buffered >= 0 && pread(buffered, destination, CHUNK, 0) == CHUNK,
	      "independent buffered observation");
	CHECK(!memcmp(destination, source + 2 * PAGE, PAGE), "actual file bytes visible");
	CHECK(!close(buffered), "close observer");
	puts("direct I/O: bounded vector transfer and independent file observation pass");

	errno = 0;
	CHECK(pread(fd, destination + 1, PAGE, 0) == -1 && errno == EINVAL,
	      "unaligned user pointer remains invalid");
	errno = 0;
	CHECK(pwrite(fd, source, 3 * PAGE + 1, 0) == -1 && errno == EINVAL,
	      "full unaligned length is not hidden by chunking");
	errno = 0;
	CHECK(pread(fd, destination, PAGE, 1) == -1 && errno == EINVAL,
	      "unaligned file offset remains invalid");
	void *volatile bad = NULL;
	errno = 0;
	CHECK(pwrite(fd, bad, PAGE, 0) == -1 && errno == EFAULT, "bad write has no I/O");
	errno = 0;
	CHECK(pread(fd, bad, PAGE, 0) == -1 && errno == EFAULT, "bad read delivery");
	CHECK(lseek(fd, 0, SEEK_CUR) == CHUNK, "failed positional calls preserve fd position");
	CHECK(pread(fd, destination, PAGE, 0) == PAGE &&
	      !memcmp(destination, source + 2 * PAGE, PAGE), "recovery and no failed-write mutation");
	CHECK(!close(fd) && !unlink("/direct-io-data"), "close and remove file");
	puts("direct I/O: alignment, address errors, recovery and cleanup pass");
	check_block_device(source, destination);
	free(source);
	free(destination);
	return 0;
}
