// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <linux/fsverity.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define BASE_DIR "/tmp/fsverity-test"
#define TARGET_FILE BASE_DIR "/protected.bin"
#define PAYLOAD_SIZE 16384

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "fsverity-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static uint8_t pattern_byte(size_t index)
{
	return (uint8_t)((index * 131u + 17u) & 0xffu);
}

static void write_test_file(const char *path)
{
	uint8_t buf[PAYLOAD_SIZE];
	for (size_t i = 0; i < sizeof(buf); i++) {
		buf[i] = pattern_byte(i);
	}

	int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(fd >= 0, "create target file");
	size_t done = 0;
	while (done < sizeof(buf)) {
		ssize_t n = write(fd, buf + done, sizeof(buf) - done);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "write target payload");
		done += (size_t)n;
	}
	require(fsync(fd) == 0, "fsync target payload");
	require(close(fd) == 0, "close writable target fd");
}

static void verify_read_contents(int fd)
{
	require(lseek(fd, 0, SEEK_SET) == 0, "lseek to start");
	uint8_t buf[PAYLOAD_SIZE];
	size_t done = 0;
	while (done < sizeof(buf)) {
		ssize_t n = read(fd, buf + done, sizeof(buf) - done);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "read verity-protected file");
		done += (size_t)n;
	}
	for (size_t i = 0; i < sizeof(buf); i++) {
		require(buf[i] == pattern_byte(i),
			"verity-protected read byte matches");
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	require(mkdir(BASE_DIR, 0755) == 0, "mkdir base ext4 mountpoint");
	require(mount("/dev/vda", BASE_DIR, "ext4", 0, NULL) == 0,
		"mount ext4 /dev/vda for fsverity");

	write_test_file(TARGET_FILE);

	int ro_fd = open(TARGET_FILE, O_RDONLY);
	require(ro_fd >= 0, "open target O_RDONLY before FS_IOC_ENABLE_VERITY");

	struct fsverity_enable_arg enable_arg;
	memset(&enable_arg, 0, sizeof(enable_arg));
	enable_arg.version = 1;
	enable_arg.hash_algorithm = FS_VERITY_HASH_ALG_SHA256;
	enable_arg.block_size = 4096;

	require(ioctl(ro_fd, FS_IOC_ENABLE_VERITY, &enable_arg) == 0,
		"FS_IOC_ENABLE_VERITY");

	int flags = 0;
	require(ioctl(ro_fd, FS_IOC_GETFLAGS, &flags) == 0, "FS_IOC_GETFLAGS");
	require((flags & FS_VERITY_FL) != 0, "FS_VERITY_FL is set");

	union {
		struct fsverity_digest hdr;
		uint8_t raw[sizeof(struct fsverity_digest) + 32];
	} d1, d2;
	memset(&d1, 0, sizeof(d1));
	memset(&d2, 0, sizeof(d2));
	d1.hdr.digest_size = 32;
	d2.hdr.digest_size = 32;

	require(ioctl(ro_fd, FS_IOC_MEASURE_VERITY, &d1.hdr) == 0,
		"FS_IOC_MEASURE_VERITY on initial fd");
	require(d1.hdr.digest_algorithm == FS_VERITY_HASH_ALG_SHA256 &&
			d1.hdr.digest_size == 32,
		"measure returns SHA-256 32-byte digest");

	int ro_fd2 = open(TARGET_FILE, O_RDONLY);
	require(ro_fd2 >= 0, "reopen verity file O_RDONLY");
	require(ioctl(ro_fd2, FS_IOC_MEASURE_VERITY, &d2.hdr) == 0,
		"FS_IOC_MEASURE_VERITY on second fd");
	require(memcmp(d1.hdr.digest, d2.hdr.digest, 32) == 0,
		"verity digest is stable across opens");

	uint8_t meta_buf[4096];
	struct fsverity_read_metadata_arg meta_arg;
	memset(&meta_arg, 0, sizeof(meta_arg));
	meta_arg.metadata_type = FS_VERITY_METADATA_TYPE_DESCRIPTOR;
	meta_arg.length = sizeof(meta_buf);
	meta_arg.buf_ptr = (uint64_t)(uintptr_t)meta_buf;
	int desc_len = ioctl(ro_fd, FS_IOC_READ_VERITY_METADATA, &meta_arg);
	require(desc_len > 0, "FS_IOC_READ_VERITY_METADATA descriptor");

	memset(&meta_arg, 0, sizeof(meta_arg));
	meta_arg.metadata_type = FS_VERITY_METADATA_TYPE_MERKLE_TREE;
	meta_arg.length = sizeof(meta_buf);
	meta_arg.buf_ptr = (uint64_t)(uintptr_t)meta_buf;
	int tree_len = ioctl(ro_fd, FS_IOC_READ_VERITY_METADATA, &meta_arg);
	require(tree_len > 0, "FS_IOC_READ_VERITY_METADATA merkle tree");

	errno = 0;
	int rw_fd = open(TARGET_FILE, O_RDWR);
	require(rw_fd == -1 &&
			(errno == ETXTBSY || errno == EACCES || errno == EPERM),
		"open(O_RDWR) rejected on verity file");

	errno = 0;
	int wo_fd = open(TARGET_FILE, O_WRONLY);
	require(wo_fd == -1 &&
			(errno == ETXTBSY || errno == EACCES || errno == EPERM),
		"open(O_WRONLY) rejected on verity file");

	errno = 0;
	require(truncate(TARGET_FILE, 123) == -1 &&
			(errno == ETXTBSY || errno == EACCES || errno == EPERM),
		"truncate rejected on verity file");

	verify_read_contents(ro_fd);
	verify_read_contents(ro_fd2);

	require(close(ro_fd2) == 0, "close ro_fd2");
	require(close(ro_fd) == 0, "close ro_fd");
	require(unlink(TARGET_FILE) == 0, "unlink verity file");
	require(umount(BASE_DIR) == 0, "umount backing ext4");
	require(rmdir(BASE_DIR) == 0, "rmdir base dir");

	puts("fsverity runtime: enable, measure, metadata read, immutability and verified read pass");
	return 0;
}
