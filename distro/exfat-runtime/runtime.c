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
#define EXFAT_DIR MNT_DIR "/ExFatDir"
#define EXFAT_FILE EXFAT_DIR "/LongExFatFile.bin"
#define EXFAT_RENAMED_NAME "RenamedExFat-\xc3\xa9.bin"
#define EXFAT_RENAMED EXFAT_DIR "/" EXFAT_RENAMED_NAME
#define EXFAT_MAGIC_VAL 0x2011BAB0U
#define WRITE_SIZE 36864U
#define EXTEND_SIZE 40960U

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "exfat-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static uint8_t pattern_byte(size_t offset)
{
	return (uint8_t)((offset * 151u + 19u) & 0xffu);
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	if (mkdir(MNT_DIR, 0755) != 0) {
		require(errno == EEXIST, "mkdir /mnt");
	}
	if (mount(DEV_PATH, MNT_DIR, "exfat", 0, "iocharset=utf8") != 0) {
		require(errno == EINVAL &&
				mount(DEV_PATH, MNT_DIR, "exfat", 0, NULL) == 0,
			"mount exfat /dev/vda");
	}

	struct statfs sfs;
	require(statfs(MNT_DIR, &sfs) == 0, "statfs /mnt");
	require((uint32_t)sfs.f_type == EXFAT_MAGIC_VAL,
		"statfs f_type == EXFAT_SUPER_MAGIC");

	require(mkdir(EXFAT_DIR, 0755) == 0, "mkdir ExFatDir");

	int fd = open(EXFAT_FILE, O_CREAT | O_RDWR | O_TRUNC, 0644);
	require(fd >= 0, "create LongExFatFile.bin");

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
		require(n > 0, "write pattern to exFAT");
		done += (size_t)n;
	}
	require(ftruncate(fd, EXTEND_SIZE) == 0, "ftruncate extend exFAT file");
	require(fsync(fd) == 0, "fsync exFAT file");
	require(close(fd) == 0, "close exFAT file");

	require(rename(EXFAT_FILE, EXFAT_RENAMED) == 0,
		"rename to UTF-8 LFN");

	DIR *d = opendir(EXFAT_DIR);
	require(d != NULL, "opendir ExFatDir");
	int saw_renamed = 0;
	int saw_old = 0;
	struct dirent *ent;
	while ((ent = readdir(d)) != NULL) {
		if (strcmp(ent->d_name, EXFAT_RENAMED_NAME) == 0) {
			saw_renamed = 1;
		}
		if (strcmp(ent->d_name, "LongExFatFile.bin") == 0) {
			saw_old = 1;
		}
	}
	require(closedir(d) == 0, "closedir ExFatDir");
	require(saw_renamed == 1 && saw_old == 0,
		"readdir shows UTF-8 renamed LFN");

	int rfd = open(EXFAT_RENAMED, O_RDONLY);
	require(rfd >= 0, "reopen UTF-8 renamed file");
	struct stat st;
	require(fstat(rfd, &st) == 0 && (size_t)st.st_size == EXTEND_SIZE,
		"fstat extended exFAT size");
	uint8_t rbuf[4096];
	done = 0;
	while (done < EXTEND_SIZE) {
		size_t chunk = EXTEND_SIZE - done;
		if (chunk > sizeof(rbuf)) chunk = sizeof(rbuf);
		ssize_t n = read(rfd, rbuf, chunk);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "read exFAT file");
		for (ssize_t i = 0; i < n; i++) {
			size_t pos = done + (size_t)i;
			uint8_t exp = pos < WRITE_SIZE ? pattern_byte(pos) : 0;
			require(rbuf[i] == exp, "exFAT byte matches expected");
		}
		done += (size_t)n;
	}
	require(close(rfd) == 0, "close read exFAT file");

	errno = 0;
	require(symlink(EXFAT_RENAMED_NAME, EXFAT_DIR "/sym.txt") == -1 &&
			(errno == EPERM || errno == ENOSYS || errno == EINVAL),
		"symlink rejected on exFAT");
	errno = 0;
	require(link(EXFAT_RENAMED, EXFAT_DIR "/hard.txt") == -1 &&
			(errno == EPERM || errno == ENOSYS || errno == EINVAL),
		"hardlink rejected on exFAT");

	require(unlink(EXFAT_RENAMED) == 0, "unlink renamed exFAT file");
	require(rmdir(EXFAT_DIR) == 0, "rmdir ExFatDir");
	require(umount(MNT_DIR) == 0, "umount /mnt");

	puts("exfat runtime: mount, statfs, UTF-8 LFN, truncate, rename and link EPERM pass");
	return 0;
}
