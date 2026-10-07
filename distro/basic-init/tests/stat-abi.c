/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"

#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static void same_metadata(const struct stat *a, const struct stat *b)
{
	if (a->st_dev != b->st_dev || a->st_ino != b->st_ino ||
	    a->st_mode != b->st_mode || a->st_nlink != b->st_nlink ||
	    a->st_uid != b->st_uid || a->st_gid != b->st_gid ||
	    a->st_rdev != b->st_rdev || a->st_size != b->st_size ||
	    a->st_blksize != b->st_blksize || a->st_blocks != b->st_blocks ||
	    a->st_atim.tv_sec != b->st_atim.tv_sec ||
	    a->st_atim.tv_nsec != b->st_atim.tv_nsec ||
	    a->st_mtim.tv_sec != b->st_mtim.tv_sec ||
	    a->st_mtim.tv_nsec != b->st_mtim.tv_nsec ||
	    a->st_ctim.tv_sec != b->st_ctim.tv_sec ||
	    a->st_ctim.tv_nsec != b->st_ctim.tv_nsec)
		test_fail("stat APIs disagree on file metadata");
}

int main(void)
{
	_Static_assert(sizeof(time_t) == 8, "stat requires 64-bit time_t");
	_Static_assert(sizeof(off_t) == 8, "stat requires 64-bit off_t");
	const char payload[] = "stat-abi-payload";
	const struct timespec times[2] = {
		{ .tv_sec = 2200000001LL, .tv_nsec = 123456789 },
		{ .tv_sec = 2200000002LL, .tv_nsec = 987654321 },
	};
	struct stat expected, actual, link_info;
	if (mkdir("/stat-abi", 0700)) test_perror("mkdir stat fixture");
	int dir = open("/stat-abi", O_RDONLY | O_DIRECTORY);
	if (dir < 0) test_perror("open stat directory");
	int fd = openat(dir, "file", O_CREAT | O_EXCL | O_RDWR, 0600);
	if (fd < 0) test_perror("create stat file");
	if (write(fd, payload, sizeof(payload) - 1) != (ssize_t)(sizeof(payload) - 1))
		test_perror("write stat payload");
	if (fchmod(fd, 0640) || linkat(dir, "file", dir, "hard", 0) ||
	    symlinkat("file", dir, "soft")) test_perror("prepare stat links");
	/* No reads or metadata mutations between the reference and comparisons.
	 * ramfs block accounting is filesystem-specific: compare, don't guess it. */
	if (futimens(fd, times)) test_perror("set post-2038 timestamps");
	if (fstat(fd, &expected)) test_perror("fstat reference");
	if (!S_ISREG(expected.st_mode) || (expected.st_mode & 07777) != 0640 ||
	    expected.st_nlink != 2 || expected.st_size != (off_t)(sizeof(payload) - 1) ||
	    expected.st_uid != getuid() || expected.st_gid != getgid() ||
	    expected.st_blksize <= 0 || expected.st_blocks < 0)
		test_fail("invalid regular file metadata");
	if (expected.st_atim.tv_sec != times[0].tv_sec ||
	    expected.st_atim.tv_nsec != times[0].tv_nsec ||
	    expected.st_mtim.tv_sec != times[1].tv_sec ||
	    expected.st_mtim.tv_nsec != times[1].tv_nsec)
		test_fail("post-2038 timestamp or nanosecond truncation");
	if (stat("/stat-abi/file", &actual)) test_perror("stat file");
	same_metadata(&expected, &actual);
	if (lstat("/stat-abi/hard", &actual)) test_perror("lstat hard link");
	same_metadata(&expected, &actual);
	if (fstatat(dir, "hard", &actual, 0)) test_perror("fstatat hard link");
	same_metadata(&expected, &actual);
	if (stat("/stat-abi/soft", &actual)) test_perror("stat follow symlink");
	same_metadata(&expected, &actual);
	if (fstatat(dir, "soft", &actual, 0)) test_perror("fstatat follow symlink");
	same_metadata(&expected, &actual);
	if (fstatat(fd, "", &actual, AT_EMPTY_PATH)) test_perror("fstatat empty path");
	same_metadata(&expected, &actual);
	if (lstat("/stat-abi/soft", &link_info)) test_perror("lstat symlink");
	if (!S_ISLNK(link_info.st_mode) || link_info.st_nlink != 1 ||
	    link_info.st_size != 4 || link_info.st_ino == expected.st_ino)
		test_fail("lstat did not describe symlink itself");
	if (fstatat(dir, "soft", &actual, AT_SYMLINK_NOFOLLOW))
		test_perror("fstatat nofollow symlink");
	same_metadata(&link_info, &actual);
	errno = 0;
	if (fstatat(dir, "missing", &actual, 0) != -1 || errno != ENOENT)
		test_fail("missing path did not return ENOENT");
	errno = 0;
	if (fstat(-1, &actual) != -1 || errno != EBADF)
		test_fail("invalid fd did not return EBADF");
	if (unlinkat(dir, "file", 0)) test_perror("unlink first hard link");
	if (fstat(fd, &actual)) test_perror("fstat one remaining link");
	if (actual.st_nlink != 1 || actual.st_ino != expected.st_ino)
		test_fail("first unlink did not decrement link count");
	if (unlinkat(dir, "hard", 0)) test_perror("unlink last hard link");
	if (fstat(fd, &actual)) test_perror("fstat unlinked open file");
	if (actual.st_nlink != 0 || actual.st_ino != expected.st_ino ||
	    actual.st_size != expected.st_size)
		test_fail("unlinked open file lost identity or retained links");
	errno = 0;
	if (stat("/stat-abi/soft", &actual) != -1 || errno != ENOENT)
		test_fail("dangling symlink did not return ENOENT");
	if (lstat("/stat-abi/soft", &actual)) test_perror("lstat dangling symlink");
	/* Following a symlink can update its atime; only identity is stable here. */
	if (!S_ISLNK(actual.st_mode) || actual.st_ino != link_info.st_ino ||
	    actual.st_dev != link_info.st_dev || actual.st_nlink != 1 ||
	    actual.st_size != link_info.st_size)
		test_fail("dangling symlink lost its own metadata");
	if (close(fd) || unlinkat(dir, "soft", 0) || close(dir) || rmdir("/stat-abi"))
		test_perror("cleanup stat fixture");
	puts("stat ABI: metadata, links and post-2038 timestamps verified");
	test_pass();
}
