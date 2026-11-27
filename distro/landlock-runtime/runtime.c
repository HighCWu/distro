// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

#define BASE_DIR "/tmp/landlock-test"
#define DIR_RW BASE_DIR "/allowed_rw"
#define DIR_RO BASE_DIR "/allowed_ro"
#define DIR_DENIED BASE_DIR "/denied"
#define FILE_RW DIR_RW "/ok.txt"
#define FILE_RW_NEW DIR_RW "/new.txt"
#define FILE_RO DIR_RO "/ro.txt"
#define FILE_RO_BLOCKED DIR_RO "/blocked.txt"
#define FILE_DENIED DIR_DENIED "/secret.txt"

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "landlock-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void write_file_str(const char *path, const char *s)
{
	int fd = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0644);
	require(fd >= 0, path);
	size_t len = strlen(s);
	require(write(fd, s, len) == (ssize_t)len, "write fixture");
	require(close(fd) == 0, "close fixture");
}

static void expect_file_str(const char *path, const char *expected)
{
	int fd = open(path, O_RDONLY);
	require(fd >= 0, path);
	char buf[64] = { 0 };
	ssize_t n = read(fd, buf, sizeof(buf) - 1);
	require(n == (ssize_t)strlen(expected) && strcmp(buf, expected) == 0,
		"read expected contents");
	require(close(fd) == 0, "close read file");
}

static void add_path_rule(int ruleset_fd, const char *dir_path,
			  uint64_t allowed_access)
{
	int dir_fd = open(dir_path, O_PATH | O_CLOEXEC);
	require(dir_fd >= 0, dir_path);
	struct landlock_path_beneath_attr rule;
	memset(&rule, 0, sizeof(rule));
	rule.allowed_access = allowed_access;
	rule.parent_fd = dir_fd;
	require(syscall(__NR_landlock_add_rule, (long)ruleset_fd,
			(long)LANDLOCK_RULE_PATH_BENEATH, (long)&rule,
			0L) == 0,
		"landlock_add_rule");
	require(close(dir_fd) == 0, "close O_PATH dir_fd");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	if (mkdir(BASE_DIR, 0755) != 0) {
		require(errno == EEXIST, "mkdir BASE_DIR");
	}
	require(mkdir(DIR_RW, 0755) == 0, "mkdir allowed_rw");
	require(mkdir(DIR_RO, 0755) == 0, "mkdir allowed_ro");
	require(mkdir(DIR_DENIED, 0755) == 0, "mkdir denied");

	write_file_str(FILE_RW, "rw-initial");
	write_file_str(FILE_RO, "ro-content");
	write_file_str(FILE_DENIED, "top-secret");

	/* Query ABI version and verify denied/secret.txt is readable beforehand. */
	long abi = syscall(__NR_landlock_create_ruleset, 0L, 0L,
			   (long)LANDLOCK_CREATE_RULESET_VERSION);
	require(abi >= 1, "landlock ABI version >= 1");
	expect_file_str(FILE_DENIED, "top-secret");

	uint64_t read_rights = LANDLOCK_ACCESS_FS_READ_FILE |
			       LANDLOCK_ACCESS_FS_READ_DIR;
	uint64_t write_rights = LANDLOCK_ACCESS_FS_WRITE_FILE |
				LANDLOCK_ACCESS_FS_MAKE_REG |
				LANDLOCK_ACCESS_FS_REMOVE_FILE;

	struct landlock_ruleset_attr attr;
	memset(&attr, 0, sizeof(attr));
	attr.handled_access_fs = read_rights | write_rights;

	int ruleset_fd = (int)syscall(__NR_landlock_create_ruleset, (long)&attr,
				      (long)sizeof(attr), 0L);
	require(ruleset_fd >= 0, "landlock_create_ruleset");

	add_path_rule(ruleset_fd, DIR_RW, read_rights | write_rights);
	add_path_rule(ruleset_fd, DIR_RO, read_rights);

	require(prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) == 0,
		"prctl(PR_SET_NO_NEW_PRIVS, 1)");
	require(syscall(__NR_landlock_restrict_self, (long)ruleset_fd, 0L) == 0,
		"landlock_restrict_self");
	require(close(ruleset_fd) == 0, "close ruleset_fd");

	/* 1. allowed_rw: read, overwrite, create and unlink succeed. */
	expect_file_str(FILE_RW, "rw-initial");
	write_file_str(FILE_RW, "rw-updated");
	expect_file_str(FILE_RW, "rw-updated");
	write_file_str(FILE_RW_NEW, "rw-new");
	expect_file_str(FILE_RW_NEW, "rw-new");
	require(unlink(FILE_RW_NEW) == 0, "unlink allowed_rw/new.txt");

	/* 2. allowed_ro: read succeeds, write/create fail with EACCES. */
	expect_file_str(FILE_RO, "ro-content");
	errno = 0;
	require(open(FILE_RO, O_WRONLY) == -1 && errno == EACCES,
		"allowed_ro O_WRONLY fails with EACCES");
	errno = 0;
	require(open(FILE_RO, O_RDWR) == -1 && errno == EACCES,
		"allowed_ro O_RDWR fails with EACCES");
	errno = 0;
	require(open(FILE_RO_BLOCKED, O_CREAT | O_WRONLY, 0644) == -1 &&
			errno == EACCES,
		"allowed_ro O_CREAT fails with EACCES");

	/* 3. denied: read fails with EACCES. */
	errno = 0;
	require(open(FILE_DENIED, O_RDONLY) == -1 && errno == EACCES,
		"denied O_RDONLY fails with EACCES");

	puts("landlock runtime: ABI, ruleset, allowed_rw, allowed_ro and denied EACCES pass");
	return 0;
}
