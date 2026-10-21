/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: large-file: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

int main(void)
{
	char path[] = "/tmp/large-file-XXXXXX";
	int fd = mkstemp(path);
	require(fd >= 0, "create file");
	const off_t page = 65536, high = 0x100000000LL + 3 * 65536 + 17;
	const char payload[] = "wide\0offset";
	char bytes[sizeof(payload)];
	struct stat status;
	require(ftruncate(fd, high + 2 * page) == 0 && fstat(fd, &status) == 0 &&
	        status.st_size == high + 2 * page, "64-bit sparse size");
	require(lseek(fd, 123, SEEK_SET) == 123 && pwrite(fd, payload, sizeof(payload), high) == sizeof(payload), "high pwrite");
	require(pread(fd, bytes, sizeof(bytes), high) == sizeof(bytes) &&
	        memcmp(bytes, payload, sizeof(bytes)) == 0 && lseek(fd, 0, SEEK_CUR) == 123, "high pread and unchanged position");
	memset(bytes, 0x7f, sizeof(bytes));
	require(pread(fd, bytes, sizeof(bytes), high & 0xffffffffLL) == sizeof(bytes), "low alias read");
	for (size_t i = 0; i < sizeof(bytes); i++) require(bytes[i] == 0, "high write must not alias low offset");
	puts("large-file: sparse size, scalar positioned I/O above 4 GiB and no low alias pass");
	struct iovec vectors[] = {{(void *)payload, 4}, {(void *)(payload + 4), sizeof(payload) - 4}};
	require(pwritev(fd, vectors, 2, high + page) == sizeof(payload), "high vectored write");
	vectors[0] = (struct iovec){bytes, 4};
	vectors[1] = (struct iovec){bytes + 4, sizeof(bytes) - 4};
	require(preadv(fd, vectors, 2, high + page) == sizeof(payload) &&
	        memcmp(bytes, payload, sizeof(bytes)) == 0 && lseek(fd, 0, SEEK_CUR) == 123, "explicit split-word vectored I/O");
	puts("large-file: vectored high-offset I/O preserves bytes and descriptor position pass");
	require(fallocate(fd, 0, high + 4 * page, page) == 0 && fstat(fd, &status) == 0 &&
	        status.st_size == high + 5 * page, "fallocate offset and length");
	require(posix_fallocate(fd, high + 6 * page, page) == 0 && fstat(fd, &status) == 0 &&
	        status.st_size == high + 7 * page, "posix allocation offset and length");
	require(pread(fd, bytes, sizeof(bytes), high + 4 * page) == sizeof(bytes), "allocated region read");
	for (size_t i = 0; i < sizeof(bytes); i++) require(bytes[i] == 0, "allocated bytes are zero");
	require(posix_fadvise(fd, high, 2 * page, POSIX_FADV_NORMAL) == 0 &&
	        sync_file_range(fd, high, 2 * page, SYNC_FILE_RANGE_WAIT_BEFORE | SYNC_FILE_RANGE_WRITE | SYNC_FILE_RANGE_WAIT_AFTER) == 0 &&
	        fsync(fd) == 0, "wide range advice and sync");
	puts("large-file: allocation, advice and sync preserve two wide arguments and trailing flags pass");
	require(truncate(path, high + 1) == 0 && fstat(fd, &status) == 0 && status.st_size == high + 1 &&
	        pread(fd, bytes, sizeof(bytes), high) == 1 && bytes[0] == payload[0], "path truncate and short read");
	require(ftruncate(fd, 17) == 0 && fstat(fd, &status) == 0 && status.st_size == 17, "descriptor truncate");
	require(pread(fd, bytes, sizeof(bytes), -1) == -1 && errno == EINVAL, "negative scalar offset");
	require(ftruncate(fd, -1) == -1 && errno == EINVAL, "negative truncate length");
	require(fallocate(fd, 0, -1, page) == -1 && errno == EINVAL, "negative allocation offset");
	errno = EDOM;
	require(posix_fallocate(fd, -1, page) == EINVAL && errno == EDOM, "POSIX error does not change errno");
	require(fstat(fd, &status) == 0 && status.st_size == 17 && close(fd) == 0 && unlink(path) == 0, "error recovery and cleanup");
	puts("large-file: truncation, negative signed offsets, POSIX errno and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
