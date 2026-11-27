// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <unistd.h>

#define DEV_PATH "/dev/vda"
#define MNT_DIR "/mnt"
#define LFN_DIR MNT_DIR "/LongDirName"
#define LFN_FILE LFN_DIR "/LongFileNameTest.txt"
#define LFN_RENAMED LFN_DIR "/RenamedLongFileName.txt"
#define MSDOS_MAGIC_VAL 0x4d44U
#define WRITE_SIZE 20480U
#define EXTEND_SIZE 24576U

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "vfat-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static uint8_t pattern_byte(size_t offset)
{
	return (uint8_t)((offset * 97u + 13u) & 0xffu);
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	if (mkdir(MNT_DIR, 0755) != 0) {
		require(errno == EEXIST, "mkdir /mnt");
	}
	require(mount(DEV_PATH, MNT_DIR, "vfat", 0,
		      "codepage=437,iocharset=iso8859-1") == 0,
		"mount vfat /dev/vda");

	struct statfs sfs;
	require(statfs(MNT_DIR, &sfs) == 0, "statfs /mnt");
	require((uint32_t)sfs.f_type == MSDOS_MAGIC_VAL,
		"statfs f_type == MSDOS_SUPER_MAGIC");

	require(mkdir(LFN_DIR, 0755) == 0, "mkdir LongDirName");

	int fd = open(LFN_FILE, O_CREAT | O_RDWR | O_TRUNC, 0644);
	require(fd >= 0, "create LongFileNameTest.txt");

	uint8_t wbuf[4096];
	size_t done = 0;
	while (done < WRITE_SIZE) {
		size_t chunk = WRITE_SIZE - done;
		if (chunk > sizeof(wbuf)) chunk = sizeof(wbuf);
		for (size_t i = 0; i < chunk; i++) {
			wbuf[i] = pattern_byte(done + i);
		}
		ssize_t n = write(fd, wbuf, chunk);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "write pattern to VFAT");
		done += (size_t)n;
	}
	require(ftruncate(fd, EXTEND_SIZE) == 0, "ftruncate extend VFAT file");
	require(fsync(fd) == 0, "fsync VFAT file");
	require(close(fd) == 0, "close VFAT file");

	/* Rename LFN and verify exact LFN via readdir. */
	require(rename(LFN_FILE, LFN_RENAMED) == 0, "rename LFN file");

	DIR *d = opendir(LFN_DIR);
	require(d != NULL, "opendir LongDirName");
	int saw_renamed = 0;
	int saw_old = 0;
	struct dirent *ent;
	while ((ent = readdir(d)) != NULL) {
		if (strcmp(ent->d_name, "RenamedLongFileName.txt") == 0) {
			saw_renamed = 1;
		}
		if (strcmp(ent->d_name, "LongFileNameTest.txt") == 0) {
			saw_old = 1;
		}
	}
	require(closedir(d) == 0, "closedir LongDirName");
	require(saw_renamed == 1 && saw_old == 0,
		"readdir shows exact renamed LFN");

	/* Read back and verify pattern + zero-extended tail. */
	int rfd = open(LFN_RENAMED, O_RDONLY);
	require(rfd >= 0, "reopen RenamedLongFileName.txt");
	struct stat st;
	require(fstat(rfd, &st) == 0 && (size_t)st.st_size == EXTEND_SIZE,
		"fstat extended VFAT size");
	uint8_t rbuf[4096];
	done = 0;
	while (done < EXTEND_SIZE) {
		size_t chunk = EXTEND_SIZE - done;
		if (chunk > sizeof(rbuf)) chunk = sizeof(rbuf);
		ssize_t n = read(rfd, rbuf, chunk);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "read VFAT file");
		for (ssize_t i = 0; i < n; i++) {
			size_t pos = done + (size_t)i;
			uint8_t exp = pos < WRITE_SIZE ? pattern_byte(pos) : 0;
			require(rbuf[i] == exp, "VFAT byte matches expected");
		}
		done += (size_t)n;
	}
	require(close(rfd) == 0, "close read VFAT file");

	/* Verify symlinks and hardlinks are unsupported on VFAT. */
	errno = 0;
	require(symlink("RenamedLongFileName.txt", LFN_DIR "/sym.txt") == -1 &&
			(errno == EPERM || errno == ENOSYS || errno == EINVAL),
		"symlink rejected on VFAT");
	errno = 0;
	require(link(LFN_RENAMED, LFN_DIR "/hard.txt") == -1 &&
			(errno == EPERM || errno == ENOSYS || errno == EINVAL),
		"hardlink rejected on VFAT");

	require(unlink(LFN_RENAMED) == 0, "unlink RenamedLongFileName.txt");
	require(rmdir(LFN_DIR) == 0, "rmdir LongDirName");
	require(umount(MNT_DIR) == 0, "umount /mnt");

	puts("vfat runtime: mount, statfs, LFN, truncate, rename, readdir and link EPERM pass");
	return 0;
}
