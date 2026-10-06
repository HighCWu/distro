/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <fcntl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

/* Private query fixture only; it does not perform mmap or define application UAPI. */
#define PROVENANCE_TEST_NR 256

static void check_file(const char *path, long expected)
{
	int fd = open(path, O_RDONLY);
	char bytes[20];
	if (fd < 0) test_perror("open provenance fixture");
	if (syscall(PROVENANCE_TEST_NR, (unsigned long)fd) != expected)
		test_fail("file backing provenance mismatch");
	if (read(fd, bytes, sizeof(bytes)) != 20 || memcmp(bytes, "snapshot-provenance\n", 20))
		test_fail("EROFS fixture contents mismatch");
	if (close(fd)) test_perror("close provenance fixture");
}

int main(void)
{
	if (mkdir("/dev", 0755) && errno != EEXIST) test_perror("mkdir dev");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) && errno != EBUSY)
		test_perror("mount devtmpfs");
	if (mkdir("/snapshot", 0755) || mkdir("/ordinary", 0755)) test_perror("mkdir mounts");
	if (mount("/dev/vda", "/snapshot", "erofs", MS_RDONLY, NULL) ||
	    mount("/dev/vdb", "/ordinary", "erofs", MS_RDONLY, NULL)) test_perror("mount EROFS");
	check_file("/snapshot/data", 1);
	check_file("/ordinary/data", 0);
	int ordinary = open("/init", O_RDONLY);
	if (ordinary < 0) test_perror("open init");
	if (syscall(PROVENANCE_TEST_NR, (unsigned long)ordinary) != 0)
		test_fail("initramfs incorrectly certified");
	if (close(ordinary)) test_perror("close init");
	errno = 0;
	if (syscall(PROVENANCE_TEST_NR, (unsigned long)-1) != -1 || errno != EBADF)
		test_fail("invalid provenance fd accepted");
	if (umount("/snapshot") || umount("/ordinary")) test_perror("unmount provenance fixtures");
	test_pass();
}
