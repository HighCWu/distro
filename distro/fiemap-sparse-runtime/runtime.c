// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/falloc.h>
#include <linux/fiemap.h>
#include <linux/fs.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

#define BASE_DIR "/tmp/fiemap-sparse-test"
#define TARGET_FILE BASE_DIR "/sparse.bin"
#define EXT4_BLOCK_SIZE 4096
#define FILE_SIZE (8 * EXT4_BLOCK_SIZE)

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "fiemap-sparse-runtime: %s (errno=%d: %s)\n", what,
		errno, strerror(errno));
	exit(1);
}

static uint8_t pattern_byte(size_t offset)
{
	return (uint8_t)(((offset * 73u + 29u) & 0xffu) | 1u);
}

static void write_pattern_file(int fd)
{
	uint8_t buf[FILE_SIZE];
	for (size_t i = 0; i < sizeof(buf); i++) {
		buf[i] = pattern_byte(i);
	}
	size_t done = 0;
	while (done < sizeof(buf)) {
		ssize_t n = pwrite(fd, buf + done, sizeof(buf) - done,
				   (off_t)done);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "pwrite initial pattern");
		done += (size_t)n;
	}
	require(fsync(fd) == 0, "fsync initial pattern");
}

static void verify_range_zero(int fd, off_t start, size_t len)
{
	uint8_t buf[EXT4_BLOCK_SIZE];
	size_t done = 0;
	while (done < len) {
		size_t chunk = len - done;
		if (chunk > sizeof(buf)) chunk = sizeof(buf);
		ssize_t n = pread(fd, buf, chunk, start + (off_t)done);
		require(n == (ssize_t)chunk, "pread zero/hole range");
		for (size_t i = 0; i < chunk; i++) {
			require(buf[i] == 0, "hole/zero range byte is 0");
		}
		done += chunk;
	}
}

static void verify_range_pattern(int fd, off_t start, size_t len)
{
	uint8_t buf[EXT4_BLOCK_SIZE];
	size_t done = 0;
	while (done < len) {
		size_t chunk = len - done;
		if (chunk > sizeof(buf)) chunk = sizeof(buf);
		ssize_t n = pread(fd, buf, chunk, start + (off_t)done);
		require(n == (ssize_t)chunk, "pread data range");
		for (size_t i = 0; i < chunk; i++) {
			require(buf[i] == pattern_byte((size_t)start + done + i),
				"data range byte matches original pattern");
		}
		done += chunk;
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	require(mkdir(BASE_DIR, 0755) == 0, "mkdir base ext4 mountpoint");
	require(mount("/dev/vda", BASE_DIR, "ext4", 0, NULL) == 0,
		"mount ext4 /dev/vda for fiemap-sparse");

	int fd = open(TARGET_FILE, O_CREAT | O_RDWR | O_TRUNC, 0644);
	require(fd >= 0, "create sparse target file");
	write_pattern_file(fd);

	/* Punch blocks 1..2 [4096, 12288) and zero block 5 [20480, 24576). */
	require(fallocate(fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
			  EXT4_BLOCK_SIZE, 2 * EXT4_BLOCK_SIZE) == 0,
		"fallocate FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE");
	require(fallocate(fd, FALLOC_FL_ZERO_RANGE, 5 * EXT4_BLOCK_SIZE,
			  EXT4_BLOCK_SIZE) == 0,
		"fallocate FALLOC_FL_ZERO_RANGE");
	require(fsync(fd) == 0, "fsync after fallocate");

	struct stat st;
	require(fstat(fd, &st) == 0, "fstat sparse file");
	require(st.st_size == FILE_SIZE, "file size preserved after punch/zero");
	require(st.st_blocks * 512 < FILE_SIZE,
		"punched hole released disk blocks");

	/* SEEK_DATA / SEEK_HOLE boundary checks. */
	require(lseek(fd, 0, SEEK_DATA) == 0, "SEEK_DATA at 0 returns 0");
	require(lseek(fd, 0, SEEK_HOLE) == EXT4_BLOCK_SIZE,
		"SEEK_HOLE at 0 returns start of punched hole");
	require(lseek(fd, EXT4_BLOCK_SIZE, SEEK_DATA) == 3 * EXT4_BLOCK_SIZE,
		"SEEK_DATA inside punched hole jumps to 12288");

	errno = 0;
	require(lseek(fd, FILE_SIZE, SEEK_DATA) == -1 && errno == ENXIO,
		"SEEK_DATA at EOF returns ENXIO");
	errno = 0;
	require(lseek(fd, FILE_SIZE, SEEK_HOLE) == -1 && errno == ENXIO,
		"SEEK_HOLE at EOF returns ENXIO");

	/* FS_IOC_FIEMAP multi-extent verification. */
	union {
		struct fiemap hdr;
		uint8_t raw[sizeof(struct fiemap) +
			    16 * sizeof(struct fiemap_extent)];
	} fm;
	memset(&fm, 0, sizeof(fm));
	fm.hdr.fm_start = 0;
	fm.hdr.fm_length = FIEMAP_MAX_OFFSET;
	fm.hdr.fm_flags = FIEMAP_FLAG_SYNC;
	fm.hdr.fm_extent_count = 16;

	require(ioctl(fd, FS_IOC_FIEMAP, &fm.hdr) == 0, "FS_IOC_FIEMAP");
	require(fm.hdr.fm_mapped_extents >= 2,
		"FS_IOC_FIEMAP reports multiple extents around hole");

	uint64_t prev_end = 0;
	for (uint32_t i = 0; i < fm.hdr.fm_mapped_extents; i++) {
		const struct fiemap_extent *ext = &fm.hdr.fm_extents[i];
		require(ext->fe_length > 0, "extent length > 0");
		require(ext->fe_physical > 0, "extent physical offset > 0");
		require(ext->fe_logical >= prev_end,
			"extents are monotonically ordered");
		/* Punched hole [4096, 12288) must not appear as mapped. */
		uint64_t ext_end = ext->fe_logical + ext->fe_length;
		require(ext_end <= EXT4_BLOCK_SIZE ||
				ext->fe_logical >= 3 * EXT4_BLOCK_SIZE,
			"punched hole is absent from FIEMAP extents");
		prev_end = ext_end;
	}
	require((fm.hdr.fm_extents[fm.hdr.fm_mapped_extents - 1].fe_flags &
		 FIEMAP_EXTENT_LAST) != 0,
		"final extent carries FIEMAP_EXTENT_LAST");

	/* Content verification across data, punched hole and zeroed range. */
	verify_range_pattern(fd, 0, EXT4_BLOCK_SIZE);
	verify_range_zero(fd, EXT4_BLOCK_SIZE, 2 * EXT4_BLOCK_SIZE);
	verify_range_pattern(fd, 3 * EXT4_BLOCK_SIZE, 2 * EXT4_BLOCK_SIZE);
	verify_range_zero(fd, 5 * EXT4_BLOCK_SIZE, EXT4_BLOCK_SIZE);
	verify_range_pattern(fd, 6 * EXT4_BLOCK_SIZE, 2 * EXT4_BLOCK_SIZE);

	require(close(fd) == 0, "close sparse file");
	require(unlink(TARGET_FILE) == 0, "unlink sparse file");
	require(umount(BASE_DIR) == 0, "umount backing ext4");
	require(rmdir(BASE_DIR) == 0, "rmdir base dir");

	puts("fiemap sparse runtime: fallocate punch/zero, SEEK_DATA/SEEK_HOLE, FS_IOC_FIEMAP and pread pass");
	return 0;
}
