// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/quota.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define ROOT "/quota"

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: ext4 quota: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static long user_quota(int mount_fd, unsigned command, uid_t uid, void *data)
{
    return syscall(SYS_quotactl_fd, (long)mount_fd, (long)QCMD(command, USRQUOTA),
                   (long)uid, (long)(uintptr_t)data, 0L, 0L);
}

static void check_usage(int mount_fd, uid_t uid, unsigned inodes)
{
    struct if_dqblk quota = {0};
    require(user_quota(mount_fd, Q_GETQUOTA, uid, &quota) == 0 &&
            (quota.dqb_valid & (QIF_ILIMITS | QIF_INODES)) == (QIF_ILIMITS | QIF_INODES) &&
            quota.dqb_ihardlimit == 1 && quota.dqb_isoftlimit == 0 && quota.dqb_curinodes == inodes,
            "read the expected hard limit and inode usage");
}

int main(void)
{
#ifndef __wasm__
    require(0, "run only in the isolated Linux/Wasm VM");
#endif
    require(getpid() == 1 && getuid() == 0 && geteuid() == 0, "isolated root test process");
    require(mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) == 0, "mount devtmpfs");
    require(mkdir(ROOT, 0755) == 0 && mount("/dev/vda", ROOT, "ext4", 0, "usrquota") == 0,
            "mount writable test image with user quota enforcement");

    int mount_fd = open(ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(mount_fd >= 0, "open the ext4 mount directory");
    uint32_t format = 0;
    require(user_quota(mount_fd, Q_GETFMT, 0, &format) == 0 && format == QFMT_VFS_V1,
            "query journaled user quota format from the system inode");
    const uid_t test_uid = 65000;
    struct if_dqblk limit = {.dqb_ihardlimit = 1, .dqb_valid = QIF_ILIMITS};
    require(user_quota(mount_fd, Q_SETQUOTA, test_uid, &limit) == 0, "set user inode hard limit");
    check_usage(mount_fd, test_uid, 0);
    puts("ext4 quota: detected user quota format and set inode hard limit");

    require(mkdirat(mount_fd, "work", 0777) == 0, "create root-owned work directory");
    int work = openat(mount_fd, "work", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    require(work >= 0 && fchmod(work, 0777) == 0, "make work directory writable for the test user");
    uid_t real, effective, saved;
    require(seteuid(test_uid) == 0 && getresuid(&real, &effective, &saved) == 0 &&
            real == 0 && effective == test_uid && saved == 0,
            "switch effective UID while retaining saved root");

    int first = openat(work, "first", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    struct stat metadata;
    require(first >= 0 && fstat(first, &metadata) == 0 && metadata.st_uid == test_uid &&
            close(first) == 0, "create and charge the first inode to the test user");
    errno = 0;
    require(openat(work, "second", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600) == -1 &&
            errno == EDQUOT, "enforce hard inode quota on the second creation");
    require(fstatat(work, "second", &metadata, AT_SYMLINK_NOFOLLOW) == -1 && errno == ENOENT,
            "rejected creation leaves no file");
    require(seteuid(0) == 0 && geteuid() == 0, "restore effective root");
    check_usage(mount_fd, test_uid, 1);
    puts("ext4 quota: first inode charged and second creation returned EDQUOT");

    require(unlinkat(work, "first", 0) == 0 && syncfs(mount_fd) == 0, "unlink and flush the charged inode");
    check_usage(mount_fd, test_uid, 0);
    require(close(work) == 0 && unlinkat(mount_fd, "work", AT_REMOVEDIR) == 0 &&
            close(mount_fd) == 0 && umount(ROOT) == 0 && rmdir(ROOT) == 0 && umount("/dev") == 0,
            "remove the work directory and unmount the test filesystems");
    puts("ext4 quota: inode usage returned to zero and filesystems unmounted");
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
}
