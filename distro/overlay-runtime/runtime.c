// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/xattr.h>
#include <unistd.h>

#define BASE_DIR "/tmp/overlay-test"
#define LOWER_DIR BASE_DIR "/lower"
#define UPPER_DIR BASE_DIR "/upper"
#define WORK_DIR BASE_DIR "/work"
#define MERGED_DIR BASE_DIR "/merged"

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "overlay-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void write_file(const char *path, const char *content)
{
	int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(fd >= 0, "open file for write");
	size_t len = strlen(content);
	size_t done = 0;
	while (done < len) {
		ssize_t n = write(fd, content + done, len - done);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "write file");
		done += (size_t)n;
	}
	require(close(fd) == 0, "close written file");
}

static void expect_file(const char *path, const char *expected)
{
	int fd = open(path, O_RDONLY);
	require(fd >= 0, "open file for read");
	char buf[128] = { 0 };
	ssize_t n = read(fd, buf, sizeof(buf) - 1);
	require(n == (ssize_t)strlen(expected), "read expected length");
	require(strcmp(buf, expected) == 0, "read expected contents");
	require(close(fd) == 0, "close read file");
}

static void expect_xattr(const char *path, const char *name,
			 const char *expected)
{
	char buf[128] = { 0 };
	ssize_t n = getxattr(path, name, buf, sizeof(buf) - 1);
	require(n == (ssize_t)strlen(expected), "getxattr length");
	require(strcmp(buf, expected) == 0, "getxattr value");
}

static void setup_lower_tree(void)
{
	require(mkdir(LOWER_DIR, 0755) == 0, "mkdir lower");
	require(mkdir(UPPER_DIR, 0755) == 0, "mkdir upper");
	require(mkdir(WORK_DIR, 0755) == 0, "mkdir work");
	require(mkdir(MERGED_DIR, 0755) == 0, "mkdir merged");

	write_file(LOWER_DIR "/hello.txt", "lower-v1");
	require(setxattr(LOWER_DIR "/hello.txt", "user.test", "lower-attr", 10,
			 0) == 0,
		"setxattr on lower/hello.txt");
	write_file(LOWER_DIR "/gone.txt", "to-be-removed");

	require(mkdir(LOWER_DIR "/sub", 0755) == 0, "mkdir lower/sub");
	write_file(LOWER_DIR "/sub/old.txt", "old-in-dir");
	write_file(LOWER_DIR "/sub/keep.txt", "keep-in-dir");

	write_file(LOWER_DIR "/rename_src.txt", "from-lower");
	require(mkdir(LOWER_DIR "/rename_dir", 0755) == 0,
		"mkdir lower/rename_dir");
	write_file(LOWER_DIR "/rename_dir/item.txt", "dir-item");
}

static void test_copy_up_and_xattr(void)
{
	expect_file(MERGED_DIR "/hello.txt", "lower-v1");
	expect_xattr(MERGED_DIR "/hello.txt", "user.test", "lower-attr");

	write_file(MERGED_DIR "/hello.txt", "upper-v2");
	require(setxattr(MERGED_DIR "/hello.txt", "user.extra", "upper-attr", 10,
			 0) == 0,
		"setxattr on copied-up merged/hello.txt");

	expect_file(MERGED_DIR "/hello.txt", "upper-v2");
	expect_xattr(MERGED_DIR "/hello.txt", "user.test", "lower-attr");
	expect_xattr(MERGED_DIR "/hello.txt", "user.extra", "upper-attr");

	expect_file(LOWER_DIR "/hello.txt", "lower-v1");
	expect_file(UPPER_DIR "/hello.txt", "upper-v2");
}

static void test_whiteout(void)
{
	require(unlink(MERGED_DIR "/gone.txt") == 0, "unlink merged/gone.txt");

	struct stat st;
	errno = 0;
	require(stat(MERGED_DIR "/gone.txt", &st) == -1 && errno == ENOENT,
		"merged/gone.txt is ENOENT after unlink");
	expect_file(LOWER_DIR "/gone.txt", "to-be-removed");

	require(lstat(UPPER_DIR "/gone.txt", &st) == 0,
		"lstat whiteout in upper");
	require(S_ISCHR(st.st_mode) && major(st.st_rdev) == 0 &&
			minor(st.st_rdev) == 0,
		"upper/gone.txt is 0:0 whiteout char device");

	write_file(MERGED_DIR "/gone.txt", "recreated");
	expect_file(MERGED_DIR "/gone.txt", "recreated");
	expect_file(LOWER_DIR "/gone.txt", "to-be-removed");
}

static void test_opaque_dir(void)
{
	require(unlink(MERGED_DIR "/sub/old.txt") == 0,
		"unlink merged/sub/old.txt");
	require(unlink(MERGED_DIR "/sub/keep.txt") == 0,
		"unlink merged/sub/keep.txt");
	require(rmdir(MERGED_DIR "/sub") == 0, "rmdir merged/sub");

	require(mkdir(MERGED_DIR "/sub", 0755) == 0,
		"recreate opaque merged/sub");
	write_file(MERGED_DIR "/sub/fresh.txt", "fresh");

	struct stat st;
	errno = 0;
	require(stat(MERGED_DIR "/sub/old.txt", &st) == -1 && errno == ENOENT,
		"old lower entry hidden by opaque dir");
	errno = 0;
	require(stat(MERGED_DIR "/sub/keep.txt", &st) == -1 && errno == ENOENT,
		"keep lower entry hidden by opaque dir");

	DIR *d = opendir(MERGED_DIR "/sub");
	require(d != NULL, "opendir merged/sub");
	int saw_fresh = 0;
	int extra = 0;
	struct dirent *ent;
	while ((ent = readdir(d)) != NULL) {
		if (strcmp(ent->d_name, ".") == 0 ||
		    strcmp(ent->d_name, "..") == 0) {
			continue;
		}
		if (strcmp(ent->d_name, "fresh.txt") == 0) {
			saw_fresh = 1;
		} else {
			extra++;
		}
	}
	require(closedir(d) == 0, "closedir merged/sub");
	require(saw_fresh == 1 && extra == 0,
		"getdents64 on opaque dir lists only fresh.txt");
}

static void test_rename_and_hardlink(void)
{
	require(link(MERGED_DIR "/hello.txt", MERGED_DIR "/hello_hardlink.txt") ==
			0,
		"hardlink copied-up file");
	expect_file(MERGED_DIR "/hello_hardlink.txt", "upper-v2");

	struct stat st_a;
	struct stat st_b;
	require(stat(MERGED_DIR "/hello.txt", &st_a) == 0 &&
			stat(MERGED_DIR "/hello_hardlink.txt", &st_b) == 0,
		"stat hardlinked files");
	require(st_a.st_nlink == 2 && st_a.st_ino == st_b.st_ino,
		"hardlink shares inode and nlink=2");

	require(rename(MERGED_DIR "/rename_src.txt",
		       MERGED_DIR "/rename_dst.txt") == 0,
		"rename lower file across layers");
	struct stat st;
	errno = 0;
	require(stat(MERGED_DIR "/rename_src.txt", &st) == -1 &&
			errno == ENOENT,
		"rename_src.txt gone after rename");
	expect_file(MERGED_DIR "/rename_dst.txt", "from-lower");
	expect_file(LOWER_DIR "/rename_src.txt", "from-lower");

	errno = 0;
	int dir_rc = rename(MERGED_DIR "/rename_dir",
			    MERGED_DIR "/rename_dir_moved");
	if (dir_rc == 0) {
		expect_file(MERGED_DIR "/rename_dir_moved/item.txt",
			    "dir-item");
	} else {
		require(errno == EXDEV,
			"cross-layer dir rename returns 0 or EXDEV");
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	require(mkdir(BASE_DIR, 0755) == 0, "mkdir base tmpfs mountpoint");
	require(mount("tmpfs", BASE_DIR, "tmpfs", 0, NULL) == 0,
		"mount tmpfs for overlay backing");

	setup_lower_tree();

	char opts[512];
	int len = snprintf(opts, sizeof(opts),
			   "lowerdir=%s,upperdir=%s,workdir=%s", LOWER_DIR,
			   UPPER_DIR, WORK_DIR);
	require(len > 0 && (size_t)len < sizeof(opts), "format overlay opts");
	require(mount("overlay", MERGED_DIR, "overlay", 0, opts) == 0,
		"mount overlayfs");

	test_copy_up_and_xattr();
	test_whiteout();
	test_opaque_dir();
	test_rename_and_hardlink();

	require(umount(MERGED_DIR) == 0, "umount overlayfs");
	require(umount(BASE_DIR) == 0, "umount backing tmpfs");
	require(rmdir(BASE_DIR) == 0, "rmdir base dir");

	puts("overlay runtime: copy-up, xattr, whiteout, opaque dir, rename and umount pass");
	return 0;
}
