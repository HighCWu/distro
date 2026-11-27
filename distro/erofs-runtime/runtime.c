// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>

#define DEV_PATH "/dev/vda"
#define MNT_DIR "/mnt"
#define EROFS_MAGIC_VAL 0xE0F5E1E2U
#define LARGE_SIZE 98304U

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "erofs-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void expect_small_file(const char *path, const char *expected)
{
	int fd = open(path, O_RDONLY);
	require(fd >= 0, path);
	char buf[64] = { 0 };
	ssize_t n = read(fd, buf, sizeof(buf) - 1);
	require(n == (ssize_t)strlen(expected), "small file length");
	require(strcmp(buf, expected) == 0, "small file contents");
	require(close(fd) == 0, "close small file");
}

static void expect_large_file(const char *path)
{
	int fd = open(path, O_RDONLY);
	require(fd >= 0, "open large.bin");
	struct stat st;
	require(fstat(fd, &st) == 0 && (size_t)st.st_size == LARGE_SIZE,
		"large.bin st_size == 98304");

	uint8_t buf[4096];
	size_t offset = 0;
	while (offset < LARGE_SIZE) {
		size_t want = LARGE_SIZE - offset;
		if (want > sizeof(buf)) want = sizeof(buf);
		ssize_t n = read(fd, buf, want);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "read large.bin");
		for (ssize_t i = 0; i < n; i++) {
			uint8_t expected =
				(uint8_t)(((offset + (size_t)i) * 139u + 53u) &
					  0xffu);
			require(buf[i] == expected,
				"large.bin decompressed byte matches");
		}
		offset += (size_t)n;
	}
	require(close(fd) == 0, "close large.bin");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	if (mkdir(MNT_DIR, 0755) != 0) {
		require(errno == EEXIST, "mkdir /mnt");
	}
	require(mount(DEV_PATH, MNT_DIR, "erofs", MS_RDONLY, NULL) == 0,
		"mount erofs /dev/vda");

	struct statfs sfs;
	require(statfs(MNT_DIR, &sfs) == 0, "statfs /mnt");
	require((uint32_t)sfs.f_type == EROFS_MAGIC_VAL,
		"statfs f_type == EROFS_SUPER_MAGIC_V1");

	expect_small_file(MNT_DIR "/small.txt", "erofs-small-v1");
	expect_small_file(MNT_DIR "/nested/dir/info.txt", "erofs-nested-v1");
	expect_large_file(MNT_DIR "/large.bin");

	char target[128] = { 0 };
	ssize_t rlen = readlink(MNT_DIR "/nested/link.txt", target,
				sizeof(target) - 1);
	require(rlen == (ssize_t)strlen("dir/info.txt") &&
			strcmp(target, "dir/info.txt") == 0,
		"readlink nested/link.txt");
	expect_small_file(MNT_DIR "/nested/link.txt", "erofs-nested-v1");

	char xlist[128];
	require(listxattr(MNT_DIR "/small.txt", xlist, sizeof(xlist)) >= 0,
		"listxattr on erofs");
	errno = 0;
	require(setxattr(MNT_DIR "/small.txt", "user.test", "1", 1, 0) == -1 &&
			errno == EROFS,
		"setxattr on erofs fails with EROFS");

	errno = 0;
	int wfd = open(MNT_DIR "/small.txt", O_WRONLY);
	require(wfd == -1 && errno == EROFS,
		"open O_WRONLY on erofs fails with EROFS");

	errno = 0;
	int cfd = open(MNT_DIR "/new.txt", O_CREAT | O_WRONLY, 0644);
	require(cfd == -1 && errno == EROFS,
		"open O_CREAT on erofs fails with EROFS");

	require(umount(MNT_DIR) == 0, "umount /mnt");
	puts("erofs runtime: lz4 mount, statfs, large file, symlink, xattr and EROFS pass");
	return 0;
}
