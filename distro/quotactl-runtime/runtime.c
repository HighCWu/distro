// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/quota.h>
#include <sys/stat.h>
#include <unistd.h>

#define DEV_PATH "/dev/vda"
#define MNT_DIR "/mnt"
#define OWNED_FILE MNT_DIR "/owned.bin"
#define TEST_UID 1000

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "quotactl-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	if (mkdir(MNT_DIR, 0755) != 0) {
		require(errno == EEXIST, "mkdir /mnt");
	}
	require(mount(DEV_PATH, MNT_DIR, "ext4", 0, "usrquota") == 0,
		"mount ext4 /dev/vda with usrquota");

	uint32_t fmt = 0;
	require(quotactl(QCMD(Q_GETFMT, USRQUOTA), DEV_PATH, 0,
			 (char *)&fmt) == 0,
		"quotactl Q_GETFMT");
	require(fmt == QFMT_VFS_V1, "quota format is QFMT_VFS_V1 (QFMT_V2)");

	struct dqinfo info;
	memset(&info, 0, sizeof(info));
	require(quotactl(QCMD(Q_GETINFO, USRQUOTA), DEV_PATH, 0,
			 (char *)&info) == 0,
		"quotactl Q_GETINFO");
	uint64_t orig_bgrace = info.dqi_bgrace;
	info.dqi_bgrace = 3600;
	info.dqi_valid = IIF_BGRACE;
	require(quotactl(QCMD(Q_SETINFO, USRQUOTA), DEV_PATH, 0,
			 (char *)&info) == 0,
		"quotactl Q_SETINFO");

	struct dqinfo info_back;
	memset(&info_back, 0, sizeof(info_back));
	require(quotactl(QCMD(Q_GETINFO, USRQUOTA), DEV_PATH, 0,
			 (char *)&info_back) == 0,
		"quotactl Q_GETINFO after Q_SETINFO");
	require(info_back.dqi_bgrace == 3600, "dqi_bgrace updated to 3600");

	info.dqi_bgrace = orig_bgrace;
	info.dqi_valid = IIF_BGRACE;
	require(quotactl(QCMD(Q_SETINFO, USRQUOTA), DEV_PATH, 0,
			 (char *)&info) == 0,
		"restore dqi_bgrace");

	struct dqblk dq;
	memset(&dq, 0, sizeof(dq));
	dq.dqb_valid = QIF_LIMITS;
	dq.dqb_bsoftlimit = 64;
	dq.dqb_bhardlimit = 128;
	dq.dqb_isoftlimit = 8;
	dq.dqb_ihardlimit = 16;
	require(quotactl(QCMD(Q_SETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq) == 0,
		"quotactl Q_SETQUOTA");

	struct dqblk dq_back;
	memset(&dq_back, 0, sizeof(dq_back));
	require(quotactl(QCMD(Q_GETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq_back) == 0,
		"quotactl Q_GETQUOTA");
	require(dq_back.dqb_bsoftlimit == 64 && dq_back.dqb_bhardlimit == 128 &&
			dq_back.dqb_isoftlimit == 8 &&
			dq_back.dqb_ihardlimit == 16,
		"Q_GETQUOTA limits match Q_SETQUOTA");

	/* Create file owned by TEST_UID and write 16 KiB to verify accounting. */
	int fd = open(OWNED_FILE, O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(fd >= 0, "create owned file");
	require(fchown(fd, TEST_UID, TEST_UID) == 0, "fchown to TEST_UID");
	uint8_t buf[4096];
	memset(buf, 0x3c, sizeof(buf));
	for (int i = 0; i < 4; i++) {
		require(write(fd, buf, sizeof(buf)) == (ssize_t)sizeof(buf),
			"write 4 KiB block");
	}
	require(fsync(fd) == 0, "fsync owned file");
	require(close(fd) == 0, "close owned file");

	require(quotactl(QCMD(Q_SYNC, USRQUOTA), DEV_PATH, 0, NULL) == 0,
		"quotactl Q_SYNC");

	memset(&dq_back, 0, sizeof(dq_back));
	require(quotactl(QCMD(Q_GETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq_back) == 0,
		"quotactl Q_GETQUOTA after write");
	require(dq_back.dqb_curinodes >= 1 && dq_back.dqb_curspace >= 16384,
		"dqb_curinodes and dqb_curspace increased");

	/* Lower limits and verify Q_GETQUOTA reflects updated limits. */
	memset(&dq, 0, sizeof(dq));
	dq.dqb_valid = QIF_LIMITS;
	dq.dqb_bsoftlimit = 32;
	dq.dqb_bhardlimit = 64;
	dq.dqb_isoftlimit = 4;
	dq.dqb_ihardlimit = 8;
	require(quotactl(QCMD(Q_SETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq) == 0,
		"quotactl Q_SETQUOTA lowered limits");
	memset(&dq_back, 0, sizeof(dq_back));
	require(quotactl(QCMD(Q_GETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq_back) == 0 &&
			dq_back.dqb_bhardlimit == 64 &&
			dq_back.dqb_ihardlimit == 8,
		"lowered limits verified via Q_GETQUOTA");

	/* Cleanup file, verify usage returns to 0, reset limits and umount. */
	require(unlink(OWNED_FILE) == 0, "unlink owned file");
	require(quotactl(QCMD(Q_SYNC, USRQUOTA), DEV_PATH, 0, NULL) == 0,
		"quotactl Q_SYNC after unlink");
	memset(&dq_back, 0, sizeof(dq_back));
	require(quotactl(QCMD(Q_GETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq_back) == 0 &&
			dq_back.dqb_curinodes == 0 &&
			dq_back.dqb_curspace == 0,
		"usage returned to 0 after unlink");

	memset(&dq, 0, sizeof(dq));
	dq.dqb_valid = QIF_LIMITS;
	require(quotactl(QCMD(Q_SETQUOTA, USRQUOTA), DEV_PATH, TEST_UID,
			 (char *)&dq) == 0,
		"reset TEST_UID limits");

	require(umount(MNT_DIR) == 0, "umount /mnt");
	puts("quotactl runtime: Q_GETFMT, Q_GETINFO/SETINFO, Q_SETQUOTA/GETQUOTA, Q_SYNC and cleanup pass");
	return 0;
}
