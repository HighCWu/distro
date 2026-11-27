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
#include <unistd.h>

#define BASE_DIR "/tmp/fhandle-test"
#define TARGET_FILE BASE_DIR "/target.txt"
#define HARDLINK_FILE BASE_DIR "/hardlink.txt"

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "fhandle-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void write_file_str(const char *path, const char *s)
{
	int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(fd >= 0, "open file for write");
	size_t len = strlen(s);
	size_t done = 0;
	while (done < len) {
		ssize_t n = write(fd, s + done, len - done);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "write file");
		done += (size_t)n;
	}
	require(fsync(fd) == 0, "fsync file");
	require(close(fd) == 0, "close file");
}

static void expect_fd_str(int fd, const char *expected)
{
	require(lseek(fd, 0, SEEK_SET) == 0, "lseek to start");
	char buf[64] = { 0 };
	ssize_t n = read(fd, buf, sizeof(buf) - 1);
	require(n == (ssize_t)strlen(expected), "read expected length");
	require(strcmp(buf, expected) == 0, "read expected contents");
}

static int find_mount_id(const char *mountpoint)
{
	FILE *f = fopen("/proc/self/mountinfo", "r");
	require(f != NULL, "open /proc/self/mountinfo");

	char line[1024];
	int found_id = -1;
	while (fgets(line, sizeof(line), f) != NULL) {
		int mnt_id = -1;
		int parent_id = -1;
		char dev[64] = { 0 };
		char root[256] = { 0 };
		char mp[256] = { 0 };
		if (sscanf(line, "%d %d %63s %255s %255s", &mnt_id, &parent_id,
			   dev, root, mp) == 5) {
			if (strcmp(mp, mountpoint) == 0) {
				found_id = mnt_id;
			}
		}
	}
	require(fclose(f) == 0, "close /proc/self/mountinfo");
	return found_id;
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	require(mkdir(BASE_DIR, 0755) == 0, "mkdir base ext4 mountpoint");
	require(mount("/dev/vda", BASE_DIR, "ext4", 0, NULL) == 0,
		"mount ext4 /dev/vda for fhandle");

	write_file_str(TARGET_FILE, "fhandle-v1-payload");
	require(link(TARGET_FILE, HARDLINK_FILE) == 0, "create hardlink");

	/* 1. Probe required handle_bytes via EOVERFLOW. */
	struct file_handle probe;
	memset(&probe, 0, sizeof(probe));
	probe.handle_bytes = 0;
	int probe_mnt = -1;
	errno = 0;
	require(name_to_handle_at(AT_FDCWD, TARGET_FILE, &probe, &probe_mnt,
				  0) == -1 &&
			errno == EOVERFLOW,
		"name_to_handle_at with 0 bytes returns EOVERFLOW");
	require(probe.handle_bytes > 0 && probe.handle_bytes <= MAX_HANDLE_SZ,
		"EOVERFLOW populated valid handle_bytes");

	/* 2. Capture handles for target and its hardlink, and verify mountinfo. */
	union {
		struct file_handle hdr;
		unsigned char raw[sizeof(struct file_handle) + MAX_HANDLE_SZ];
	} h1, h2;
	memset(&h1, 0, sizeof(h1));
	memset(&h2, 0, sizeof(h2));
	h1.hdr.handle_bytes = probe.handle_bytes;
	h2.hdr.handle_bytes = probe.handle_bytes;

	int mnt1 = -1;
	int mnt2 = -1;
	require(name_to_handle_at(AT_FDCWD, TARGET_FILE, &h1.hdr, &mnt1, 0) ==
			0,
		"name_to_handle_at target");
	require(name_to_handle_at(AT_FDCWD, HARDLINK_FILE, &h2.hdr, &mnt2,
				  0) == 0,
		"name_to_handle_at hardlink");

	int expected_mnt_id = find_mount_id(BASE_DIR);
	require(expected_mnt_id >= 0 && mnt1 == expected_mnt_id,
		"name_to_handle_at mount_id matches /proc/self/mountinfo");
	require(mnt2 == mnt1 && h2.hdr.handle_type == h1.hdr.handle_type &&
			h2.hdr.handle_bytes == h1.hdr.handle_bytes &&
			memcmp(h1.hdr.f_handle, h2.hdr.f_handle,
			       h1.hdr.handle_bytes) == 0,
		"hardlink shares identical file_handle and mount_id");

	/* 3. open_by_handle_at read, update and re-read via hardlink handle. */
	int mount_fd = open(BASE_DIR, O_RDONLY | O_DIRECTORY);
	require(mount_fd >= 0, "open mount_fd");

	int ro_fd = open_by_handle_at(mount_fd, &h1.hdr, O_RDONLY);
	require(ro_fd >= 0, "open_by_handle_at O_RDONLY");
	expect_fd_str(ro_fd, "fhandle-v1-payload");
	require(close(ro_fd) == 0, "close ro_fd");

	int rw_fd = open_by_handle_at(mount_fd, &h1.hdr, O_RDWR);
	require(rw_fd >= 0, "open_by_handle_at O_RDWR");
	const char *updated = "fhandle-v2-updated";
	require(ftruncate(rw_fd, 0) == 0, "ftruncate via handle fd");
	require(pwrite(rw_fd, updated, strlen(updated), 0) ==
			(ssize_t)strlen(updated),
		"pwrite updated payload via handle fd");
	require(fsync(rw_fd) == 0, "fsync handle fd");
	require(close(rw_fd) == 0, "close rw_fd");

	int ro_fd2 = open_by_handle_at(mount_fd, &h2.hdr, O_RDONLY);
	require(ro_fd2 >= 0, "open_by_handle_at via hardlink handle");
	expect_fd_str(ro_fd2, updated);
	require(close(ro_fd2) == 0, "close ro_fd2");

	/* 4. Invalid mount_fd -> EBADF; unlink all links -> ESTALE. */
	errno = 0;
	require(open_by_handle_at(-1, &h1.hdr, O_RDONLY) == -1 &&
			errno == EBADF,
		"open_by_handle_at(-1) returns EBADF");

	require(unlink(HARDLINK_FILE) == 0, "unlink hardlink");
	require(unlink(TARGET_FILE) == 0, "unlink target");

	errno = 0;
	int stale_fd = open_by_handle_at(mount_fd, &h1.hdr, O_RDONLY);
	if (stale_fd >= 0) {
		close(stale_fd);
		require(0, "open_by_handle_at after unlink should fail with ESTALE");
	}
	require(errno == ESTALE,
		"open_by_handle_at after unlink returns ESTALE");

	require(close(mount_fd) == 0, "close mount_fd");
	require(umount(BASE_DIR) == 0, "umount backing ext4");
	require(rmdir(BASE_DIR) == 0, "rmdir base dir");

	puts("fhandle runtime: EOVERFLOW sizing, mountinfo, hardlink handle, open_by_handle_at and ESTALE pass");
	return 0;
}
