/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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
	free(source);
	free(destination);
	puts("direct I/O: alignment, address errors, recovery and cleanup pass");
	return 0;
}
