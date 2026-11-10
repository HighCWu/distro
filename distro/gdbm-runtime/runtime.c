// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <gdbm.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef GDBM_RUNTIME_EXEC_PATH
#define GDBM_RUNTIME_EXEC_PATH "/bin/gdbm-runtime"
#endif

#ifndef GDBMTOOL_EXEC_PATH
#define GDBMTOOL_EXEC_PATH "/bin/gdbmtool"
#endif

static char key_primary[] = { (char)0x00, 'k', 'e', 'y', (char)0xff };
static char key_deleted[] = { 'd', 'e', 'l', (char)0x00, 'e', 't', 'e' };
static char value_initial[] = { (char)0x00, 'g', 'd', 'b', 'm', (char)0xff, '1' };
static char value_replacement[] = {
	'r', 'e', 'p', 'l', 'a', 'c', 'e', 'd', (char)0x00, (char)0xff
};
static char value_deleted[] = { 'r', 'e', 'm', 'o', 'v', 'e', ' ', (char)0x00 };

static void
fail(const char *operation)
{
	const char *error = gdbm_strerror(gdbm_errno);
	fprintf(stderr, "gdbm-runtime: %s: %s\n", operation,
		error != NULL ? error : "unknown GDBM error");
	printf("::vm-test::fail: gdbm-runtime: %s\n", operation);
	fflush(stdout);
	exit(1);
}

static void
require(int condition, const char *operation)
{
	if (!condition)
		fail(operation);
}

static void
require_gdbm(int result, const char *operation)
{
	if (result != 0)
		fail(operation);
}

static GDBM_FILE
open_database(const char *path, int mode)
{
	struct gdbm_open_spec spec;
	gdbm_open_spec_init(&spec);
	spec.mode = 0600;
	spec.lock_wait = GDBM_LOCKWAIT_NONE;
	GDBM_FILE db = gdbm_open_ext(path,
		mode | GDBM_NOMMAP | GDBM_CLOEXEC, &spec);
	if (db == NULL)
		fail("open database");
	return db;
}

static void
require_value(GDBM_FILE db, datum key, const char *expected, size_t expected_size,
	const char *operation)
{
	datum actual = gdbm_fetch(db, key);
	if (actual.dptr == NULL)
		fail(operation);
	int matches = actual.dsize >= 0 && (size_t)actual.dsize == expected_size &&
		memcmp(actual.dptr, expected, expected_size) == 0;
	free(actual.dptr);
	require(matches, operation);
}

static void
require_missing(GDBM_FILE db, datum key, const char *operation)
{
	datum actual = gdbm_fetch(db, key);
	if (actual.dptr != NULL) {
		free(actual.dptr);
		fail(operation);
	}
	require(gdbm_errno == GDBM_ITEM_NOT_FOUND, operation);
}

static int
wait_for_child(pid_t child)
{
	int status;
	pid_t result;
	do {
		result = waitpid(child, &status, 0);
	} while (result < 0 && errno == EINTR);
	require(result == child, "wait for child process");
	require(WIFEXITED(status), "child exited normally");
	return WEXITSTATUS(status);
}

static int
run_version_child(void)
{
	pid_t child = fork();
	if (child < 0)
		fail("fork gdbmtool version check");
	if (child == 0) {
		char *const arguments[] = {
			(char *)GDBMTOOL_EXEC_PATH,
			"--version",
			NULL
		};
		execv(GDBMTOOL_EXEC_PATH, arguments);
		_exit(127);
	}
	return wait_for_child(child);
}

static int
lock_probe_child(const char *path, int inherited_fd)
{
	if (fcntl(inherited_fd, F_GETFD) != -1 || errno != EBADF)
		return 70;

	struct gdbm_open_spec spec;
	gdbm_open_spec_init(&spec);
	spec.lock_wait = GDBM_LOCKWAIT_NONE;
	GDBM_FILE db = gdbm_open_ext(path,
		GDBM_WRITER | GDBM_NOMMAP | GDBM_CLOEXEC, &spec);
	if (db != NULL) {
		(void)gdbm_close(db);
		return 71;
	}
	return gdbm_errno == GDBM_CANT_BE_WRITER ? 0 : 72;
}

static void
verify_lock_conflict(const char *path, GDBM_FILE db)
{
	int inherited_fd = gdbm_fdesc(db);
	require(inherited_fd >= 0, "get database descriptor");
	int descriptor_flags = fcntl(inherited_fd, F_GETFD);
	require(descriptor_flags >= 0 && (descriptor_flags & FD_CLOEXEC) != 0,
		"database descriptor is close-on-exec");

	char fd_text[32];
	int length = snprintf(fd_text, sizeof(fd_text), "%d", inherited_fd);
	require(length > 0 && (size_t)length < sizeof(fd_text),
		"format inherited database descriptor");
	pid_t child = fork();
	if (child < 0)
		fail("fork lock probe");
	if (child == 0) {
		char *const arguments[] = {
			(char *)GDBM_RUNTIME_EXEC_PATH,
			"--lock-probe",
			(char *)path,
			fd_text,
			NULL
		};
		execv(GDBM_RUNTIME_EXEC_PATH, arguments);
		_exit(127);
	}
	int child_status = wait_for_child(child);
	require(child_status == 0,
		"separate process observed GDBM_CANT_BE_WRITER after CLOEXEC");
}

static int
parse_fd(const char *text)
{
	char *end;
	errno = 0;
	long value = strtol(text, &end, 10);
	if (errno != 0 || *text == '\0' || *end != '\0' || value < 0 ||
		value > INT_MAX)
		return -1;
	return (int)value;
}

static int
run_lock_probe(int argc, char **argv)
{
	if (argc != 4)
		return 73;
	int inherited_fd = parse_fd(argv[3]);
	if (inherited_fd < 0)
		return 74;
	return lock_probe_child(argv[2], inherited_fd);
}

int
main(int argc, char **argv)
{
	if (argc >= 2 && strcmp(argv[1], "--lock-probe") == 0)
		return run_lock_probe(argc, argv);
	if (argc != 1) {
		fprintf(stderr, "usage: %s\n", argv[0]);
		return 64;
	}

	require(run_version_child() == 0, "run upstream gdbmtool --version");
	puts("gdbm-runtime: gdbmtool executable starts successfully");
	fflush(stdout);

	char temporary_directory[] = "/tmp/gdbm-runtime-XXXXXX";
	require(mkdtemp(temporary_directory) != NULL,
		"create isolated database directory");
	char database_path[512];
	int length = snprintf(database_path, sizeof(database_path), "%s/database.db",
		temporary_directory);
	require(length > 0 && (size_t)length < sizeof(database_path),
		"format database path");

	datum primary_key = { key_primary, (int)sizeof(key_primary) };
	datum delete_key = { key_deleted, (int)sizeof(key_deleted) };
	datum initial_value = { value_initial, (int)sizeof(value_initial) };
	datum replacement_value = {
		value_replacement, (int)sizeof(value_replacement)
	};
	datum delete_value = { value_deleted, (int)sizeof(value_deleted) };
	GDBM_FILE db = open_database(database_path, GDBM_NEWDB);
	require_gdbm(gdbm_store(db, primary_key, initial_value, GDBM_INSERT),
		"store binary key/value");
	require_value(db, primary_key, value_initial, sizeof(value_initial),
		"read initial binary value");
	require_gdbm(gdbm_store(db, primary_key, replacement_value, GDBM_REPLACE),
		"replace value for existing key");
	require_value(db, primary_key, value_replacement, sizeof(value_replacement),
		"read replaced binary value");
	require_gdbm(gdbm_store(db, delete_key, delete_value, GDBM_INSERT),
		"store key for deletion");
	require_gdbm(gdbm_delete(db, delete_key), "delete key");
	require_missing(db, delete_key, "deleted key is absent");
	require_gdbm(gdbm_sync(db), "sync database before close");
	require_gdbm(gdbm_close(db), "close database after writes");
	puts("gdbm-runtime: binary keys, replacement, and deletion passed");

	db = open_database(database_path, GDBM_READER);
	require_value(db, primary_key, value_replacement, sizeof(value_replacement),
		"read replacement after close and reopen");
	require_missing(db, delete_key, "deleted key remains absent after reopen");
	require_gdbm(gdbm_close(db), "close reopened reader");
	puts("gdbm-runtime: close/reopen persistence passed");

	db = open_database(database_path, GDBM_WRITER);
	verify_lock_conflict(database_path, db);
	require_value(db, primary_key, value_replacement, sizeof(value_replacement),
		"parent database remains usable after child lock conflict");
	require_gdbm(gdbm_close(db), "release parent database lock");

	db = open_database(database_path, GDBM_WRITER);
	require_value(db, primary_key, value_replacement, sizeof(value_replacement),
		"reopen writer after releasing lock");
	require_gdbm(gdbm_close(db), "close recovered writer");
	puts("gdbm-runtime: child lock conflict and post-close recovery passed");

	require(unlink(database_path) == 0, "remove temporary database");
	require(rmdir(temporary_directory) == 0, "remove temporary database directory");
	puts("::vm-test::pass");
	return 0;
}
