/* SPDX-License-Identifier: MIT */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif

#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static const char FilePath[] = "/metadata/cpio/file";
static const char HardlinkPath[] = "/metadata/cpio/hardlink";
static const char SymlinkPath[] = "/metadata/cpio/symlink";
static const char DirectoryPath[] = "/metadata/cpio";
static const char SubdirectoryPath[] = "/metadata/cpio/sub";
static const char NestedPath[] = "/metadata/cpio/sub/nested";
static const char Payload[] = "initramfs metadata payload\n";
static const time_t ExpectedMtime = 1600000000;

static _Noreturn void Fail(const char* Message) {
  printf("::vm-test::fail: cpio metadata: %s\n", Message);
  fflush(stdout);
  for (;;) {
    sched_yield();
  }
}

static _Noreturn void FailErrno(const char* Operation) {
  char Message[256];
  snprintf(Message, sizeof(Message), "%s: %s", Operation, strerror(errno));
  Fail(Message);
}

static void CheckModeAndMtime(const struct stat* Status, mode_t Type, mode_t Mode,
                              const char* What) {
  if ((Status->st_mode & S_IFMT) != Type) {
    Fail(What);
  }
  if ((Status->st_mode & 0777) != Mode) {
    Fail(What);
  }
  if (Status->st_mtime != ExpectedMtime) {
    Fail(What);
  }
}

int main(void) {
  struct stat FileStatus;
  struct stat HardlinkStatus;
  struct stat SymlinkStatus;
  struct stat DirectoryStatus;
  struct stat SubdirectoryStatus;
  struct stat NestedStatus;

  if (stat(FilePath, &FileStatus) != 0) {
    FailErrno("stat regular file");
  }
  CheckModeAndMtime(&FileStatus, S_IFREG, 0640, "regular file mode/mtime");
  if (FileStatus.st_size != (off_t)(sizeof(Payload) - 1) || FileStatus.st_nlink != 2) {
    Fail("regular file size/hardlink count");
  }

  if (stat(HardlinkPath, &HardlinkStatus) != 0) {
    FailErrno("stat hardlink");
  }
  CheckModeAndMtime(&HardlinkStatus, S_IFREG, 0640, "hardlink mode/mtime");
  if (HardlinkStatus.st_dev != FileStatus.st_dev || HardlinkStatus.st_ino != FileStatus.st_ino ||
      HardlinkStatus.st_nlink != 2) {
    Fail("hardlink identity");
  }

  int FD = open(FilePath, O_RDONLY | O_CLOEXEC);
  if (FD == -1) {
    FailErrno("open regular file");
  }
  char Buffer[sizeof(Payload)] = {};
  ssize_t ReadSize = read(FD, Buffer, sizeof(Buffer));
  if (ReadSize != (ssize_t)(sizeof(Payload) - 1) ||
      memcmp(Buffer, Payload, sizeof(Payload) - 1) != 0) {
    close(FD);
    Fail("regular file payload");
  }
  if (close(FD) != 0) {
    FailErrno("close regular file");
  }

  if (lstat(SymlinkPath, &SymlinkStatus) != 0) {
    FailErrno("lstat symbolic link");
  }
  CheckModeAndMtime(&SymlinkStatus, S_IFLNK, 0777, "symbolic link mode/mtime");
  char LinkTarget[16] = {};
  ssize_t LinkLength = readlink(SymlinkPath, LinkTarget, sizeof(LinkTarget));
  if (LinkLength != 4 || memcmp(LinkTarget, "file", 4) != 0) {
    Fail("symbolic link target");
  }

  if (stat(DirectoryPath, &DirectoryStatus) != 0) {
    FailErrno("stat directory");
  }
  CheckModeAndMtime(&DirectoryStatus, S_IFDIR, 0750, "directory mode/mtime");
  if (stat(SubdirectoryPath, &SubdirectoryStatus) != 0) {
    FailErrno("stat subdirectory");
  }
  CheckModeAndMtime(&SubdirectoryStatus, S_IFDIR, 0710, "subdirectory mode/mtime");
  if (stat(NestedPath, &NestedStatus) != 0) {
    FailErrno("stat nested file");
  }
  CheckModeAndMtime(&NestedStatus, S_IFREG, 0600, "nested file mode/mtime");

  puts("cpio metadata: file, directory, symlink and hardlink fields preserved");
  puts("::vm-test::pass");
  fflush(stdout);
  for (;;) {
    sched_yield();
  }
}
