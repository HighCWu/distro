/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: fchmodat: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
static void mode_is(int fd, unsigned mode)
{
	struct stat status;
	require(fstat(fd, &status) == 0 && (status.st_mode & 0777) == mode, "descriptor permission bits");
}
int main(void)
{
	if (mkdir("/tmp", 0700)) require(errno == EEXIST, "temporary root");
	char directory[] = "/tmp/fchmodat-XXXXXX";
	require(mkdtemp(directory) != NULL, "temporary directory");
	int dir = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	require(dir >= 0, "directory fd");
	int file = openat(dir, "before", O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	int path = openat(dir, "before", O_PATH | O_CLOEXEC);
	require(file >= 0 && path >= 0 && renameat(dir, "before", dir, "after") == 0, "file and O_PATH rename");
	require(fchmodat(path, "", 0640, AT_EMPTY_PATH) == 0, "empty path on renamed O_PATH descriptor");
	mode_is(file, 0640);
	require(fchmodat(dir, "after", 0604, AT_SYMLINK_NOFOLLOW) == 0, "nofollow regular file without procfs");
	mode_is(file, 0604);
	puts("fchmodat: renamed O_PATH empty-path and relative nofollow permissions pass");
	require(symlinkat("after", dir, "link") == 0, "symlink fixture");
	require(fchmodat(dir, "link", 0777, AT_SYMLINK_NOFOLLOW) == -1 && errno == EOPNOTSUPP,
	        "nofollow symlink must not modify target");
	mode_is(file, 0604);
	require(fchmodat(dir, "missing", 0600, AT_SYMLINK_NOFOLLOW) == -1 && errno == ENOENT, "missing name");
	require(fchmodat(-1, "", 0600, AT_EMPTY_PATH) == -1 && errno == EBADF, "bad descriptor");
	require(fchmodat(path, "", 0600, AT_EMPTY_PATH | AT_SYMLINK_FOLLOW) == -1 && errno == EINVAL,
	        "unsupported flag");
	mode_is(file, 0604);
	puts("fchmodat: symlink protection, invalid flags and errors preserve target pass");
	require(unlinkat(dir, "after", 0) == 0 && fchmodat(path, "", 0620, AT_EMPTY_PATH) == 0,
	        "empty path on unlinked live descriptor");
	struct stat status;
	require(fstat(file, &status) == 0 && status.st_nlink == 0, "unlinked inode lifetime");
	mode_is(file, 0620);
	require(unlinkat(dir, "link", 0) == 0 && close(path) == 0 && close(file) == 0 && close(dir) == 0 &&
	        rmdir(directory) == 0, "close and cleanup");
	puts("fchmodat: unlinked descriptor permissions, inode lifetime and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
