/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

static int report(const char *message)
{
	fprintf(stderr, "findutils fork helper: %s\n", message);
	return 2;
}

static int write_all(int descriptor, const char *buffer, size_t length)
{
	size_t written = 0;
	while (written < length) {
		ssize_t result = write(descriptor, buffer + written, length - written);
		if (result < 0 && errno == EINTR)
			continue;
		if (result <= 0)
			return -1;
		written += (size_t)result;
	}
	return 0;
}

static int path_is_absolute_list(void)
{
	const char *path = getenv("PATH"), *start;
	if (!path || !*path)
		return 0;
	start = path;
	for (;;) {
		const char *colon = strchr(start, ':');
		size_t length = colon ? (size_t)(colon - start) : strlen(start);
		if (!length || start[0] != '/')
			return 0;
		if (!colon)
			return 1;
		start = colon + 1;
	}
}

static int expected_single_path(const char *path)
{
	return !strcmp(path, "./alpha.txt") ||
		!strcmp(path, "./with space.txt") ||
		!strcmp(path, "./sub/beta.txt");
}

static int read_expected_parent(pid_t *expected)
{
	const char *path = getenv("FIND_FORK_PARENT_FILE");
	FILE *file;
	long value;
	if (!path || !(file = fopen(path, "r")))
		return -1;
	int ok = fscanf(file, "%ld", &value) == 1 && value > 1;
	if (fclose(file) != 0)
		return -1;
	if (!ok)
		return -1;
	*expected = (pid_t)value;
	return 0;
}

static int verify_find_parent(void)
{
	pid_t expected;
	if (read_expected_parent(&expected) != 0)
		return report("find parent pid file is unreadable");
	if (getppid() != expected)
		return report("-exec child was not launched by the expected find process");
	if (kill(expected, 0) != 0)
		return report("find parent was not alive while its -exec child ran");
	return 0;
}

static int append_single_record(const char *cwd, const char *path)
{
	const char *log = getenv("FIND_FORK_SINGLE_LOG");
	char line[PATH_MAX * 2 + 128];
	int descriptor, length;
	if (!log)
		return report("single-command log path was not set");
	length = snprintf(line, sizeof(line), "%ld|%ld|%s|%s\n",
		(long)getpid(), (long)getppid(), cwd, path);
	if (length < 0 || (size_t)length >= sizeof(line))
		return report("single-command log record was too long");
	descriptor = open(log, O_WRONLY | O_CREAT | O_APPEND, 0600);
	if (descriptor < 0)
		return report("could not open single-command log");
	int result = write_all(descriptor, line, (size_t)length);
	if (close(descriptor) != 0 || result != 0)
		return report("could not write single-command log");
	return 0;
}

static int run_single(int argc, char **argv)
{
	char cwd[PATH_MAX];
	if (argc != 4 || !getcwd(cwd, sizeof(cwd)))
		return report("-exec argument count or cwd was invalid");
	if (strcmp(cwd, argv[2]))
		return report("-exec child cwd changed");
	if (!expected_single_path(argv[3]))
		return report("-exec did not preserve the expected path argument");
	if (verify_find_parent() != 0)
		return 2;
	if (append_single_record(cwd, argv[3]) != 0)
		return 2;
	if (kill(getppid(), 0) != 0)
		return report("find exited before its -exec child completed");
	return 0;
}

static int expected_execdir_path(const char *path)
{
	return !strcmp(path, "./first file.txt") ||
		!strcmp(path, "./second.txt") ||
		!strcmp(path, "./third file.txt");
}

static int run_execdir(int argc, char **argv)
{
	char cwd[PATH_MAX], record[64];
	const char *log = getenv("FIND_FORK_EXECDIR_LOG");
	int descriptor, length;
	if (argc != 6 || !getcwd(cwd, sizeof(cwd)))
		return report("-execdir batch did not preserve all three arguments");
	if (strcmp(cwd, argv[2]))
		return report("-execdir child did not run in the file parent directory");
	if (!path_is_absolute_list())
		return report("-execdir inherited a relative or empty PATH component");
	for (int i = 3; i < argc; i++) {
		if (!expected_execdir_path(argv[i]))
			return report("-execdir did not preserve a spaced path argument");
		for (int j = 3; j < i; j++)
			if (!strcmp(argv[i], argv[j]))
				return report("-execdir duplicated a batched path argument");
	}
	if (!log)
		return report("-execdir log path was not set");
	descriptor = open(log, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (descriptor < 0)
		return report("-execdir was not one complete batch");
	length = snprintf(record, sizeof(record), "batch=%d\n", argc - 3);
	if (length < 0 || (size_t)length >= sizeof(record) ||
		write_all(descriptor, record, (size_t)length) != 0 || close(descriptor) != 0)
		return report("could not record -execdir batch");
	return 0;
}

static int expected_xargs_path(const char *directory, const char *path, int item)
{
	char expected[PATH_MAX];
	const char *name = item == 0 ? "item one" : "item two";
	int length = snprintf(expected, sizeof(expected), "%s/%s", directory, name);
	return length > 0 && (size_t)length < sizeof(expected) &&
		!strcmp(path, expected);
}

static int marker_path(char *buffer, size_t capacity, const char *directory,
	const char *kind, const char *slot)
{
	int length = snprintf(buffer, capacity, "%s/%s-%s", directory, kind, slot);
	return length > 0 && (size_t)length < capacity ? 0 : -1;
}

static int write_marker(const char *directory, const char *kind, const char *slot,
	pid_t pid, pid_t parent, const char *path)
{
	char filename[PATH_MAX], record[PATH_MAX + 128];
	int descriptor, length;
	if (marker_path(filename, sizeof(filename), directory, kind, slot) != 0)
		return report("parallel marker path was too long");
	length = snprintf(record, sizeof(record), "%ld|%ld|%s\n",
		(long)pid, (long)parent, path);
	if (length < 0 || (size_t)length >= sizeof(record))
		return report("parallel marker record was too long");
	descriptor = open(filename, O_WRONLY | O_CREAT | O_EXCL, 0600);
	if (descriptor < 0)
		return report("duplicate or unwriteable xargs process slot");
	int result = write_all(descriptor, record, (size_t)length);
	if (close(descriptor) != 0 || result != 0)
		return report("could not write parallel marker");
	return 0;
}

static int wait_for_pair(const char *directory, const char *kind)
{
	char zero[PATH_MAX], one[PATH_MAX];
	if (marker_path(zero, sizeof(zero), directory, kind, "0") != 0 ||
		marker_path(one, sizeof(one), directory, kind, "1") != 0)
		return report("parallel barrier path was too long");
	for (int attempt = 0; attempt < 1000; attempt++) {
		if (access(zero, F_OK) == 0 && access(one, F_OK) == 0)
			return 0;
		if (poll(NULL, 0, 10) < 0 && errno != EINTR)
			return report("parallel barrier poll failed");
	}
	return report("parallel xargs barrier timed out");
}

static int read_marker(const char *directory, const char *kind, const char *slot,
	pid_t *pid, pid_t *parent, char *argument, size_t capacity)
{
	char filename[PATH_MAX], contents[PATH_MAX + 128], *first, *second, *newline;
	char *end;
	long process, parent_process;
	int descriptor;
	ssize_t length;
	if (marker_path(filename, sizeof(filename), directory, kind, slot) != 0)
		return -1;
	descriptor = open(filename, O_RDONLY);
	if (descriptor < 0)
		return -1;
	length = read(descriptor, contents, sizeof(contents) - 1);
	int close_result = close(descriptor);
	if (length <= 0 || close_result != 0)
		return -1;
	contents[length] = '\0';
	first = strchr(contents, '|');
	if (!first)
		return -1;
	*first++ = '\0';
	second = strchr(first, '|');
	if (!second)
		return -1;
	*second++ = '\0';
	newline = strchr(second, '\n');
	if (newline)
		*newline = '\0';
	errno = 0;
	process = strtol(contents, &end, 10);
	if (errno || *end || process <= 1)
		return -1;
	errno = 0;
	parent_process = strtol(first, &end, 10);
	if (errno || *end || parent_process <= 1)
		return -1;
	if (strlen(second) >= capacity)
		return -1;
	strcpy(argument, second);
	*pid = (pid_t)process;
	*parent = (pid_t)parent_process;
	return 0;
}

static int stdin_is_dev_null(void)
{
	struct stat input, null_device;
	char byte;
	if (fstat(STDIN_FILENO, &input) != 0 || stat("/dev/null", &null_device) != 0)
		return 0;
	if (!S_ISCHR(input.st_mode) || input.st_dev != null_device.st_dev ||
		input.st_ino != null_device.st_ino)
		return 0;
	return read(STDIN_FILENO, &byte, 1) == 0;
}

static int run_parallel(int argc, char **argv)
{
	const char *slot = getenv("FIND_FORK_SLOT");
	const char *directory = getenv("FIND_FORK_HANDSHAKE_DIR");
	pid_t parent = getppid(), pid0, parent0, pid1, parent1;
	char arg0[PATH_MAX], arg1[PATH_MAX];
	if (argc != 4 || !slot || !directory ||
		(strcmp(slot, "0") && strcmp(slot, "1")))
		return report("xargs process-slot variable was absent or invalid");
	if (!expected_xargs_path(argv[2], argv[3], 0) &&
		!expected_xargs_path(argv[2], argv[3], 1))
		return report("xargs did not preserve a NUL-delimited path with spaces");
	if (!stdin_is_dev_null())
		return report("xargs child stdin was not /dev/null");
	if (kill(parent, 0) != 0)
		return report("xargs parent was not alive while children ran");
	if (write_marker(directory, "ready", slot, getpid(), parent, argv[3]) != 0)
		return 2;
	if (wait_for_pair(directory, "ready") != 0)
		return 2;
	if (write_marker(directory, "seen", slot, getpid(), parent, argv[3]) != 0)
		return 2;
	if (wait_for_pair(directory, "seen") != 0)
		return 2;
	if (read_marker(directory, "ready", "0", &pid0, &parent0, arg0, sizeof(arg0)) != 0 ||
		read_marker(directory, "ready", "1", &pid1, &parent1, arg1, sizeof(arg1)) != 0)
		return report("could not read both xargs process records");
	if (pid0 == pid1 || parent0 != parent || parent1 != parent || kill(parent, 0) != 0)
		return report("xargs children did not overlap under one live parent");
	if (!((expected_xargs_path(argv[2], arg0, 0) && expected_xargs_path(argv[2], arg1, 1)) ||
		(expected_xargs_path(argv[2], arg0, 1) && expected_xargs_path(argv[2], arg1, 0))))
		return report("xargs parallel children did not receive both input arguments");
	return 0;
}

static int run_record(int argc, char **argv)
{
	int descriptor, length;
	if (argc != 4 || !argv[2][0] || !argv[3][0])
		return report("recovery record arguments were invalid");
	descriptor = open(argv[2], O_WRONLY | O_CREAT | O_APPEND, 0600);
	if (descriptor < 0)
		return report("could not create recovery record");
	length = (int)strlen(argv[3]);
	int result = write_all(descriptor, argv[3], (size_t)length) ||
		write_all(descriptor, "\n", 1);
	if (close(descriptor) != 0 || result != 0)
		return report("could not write recovery record");
	return 0;
}

static int run_exit(int argc, char **argv)
{
	char *end;
	long code;
	if (argc != 4)
		return report("exit-mode arguments were invalid");
	errno = 0;
	code = strtol(argv[2], &end, 10);
	if (errno || *end || code < 1 || code > 125)
		return report("exit-mode status was invalid");
	return (int)code;
}

int main(int argc, char **argv)
{
	if (argc < 2)
		return report("missing helper mode");
	if (!strcmp(argv[1], "single"))
		return run_single(argc, argv);
	if (!strcmp(argv[1], "execdir"))
		return run_execdir(argc, argv);
	if (!strcmp(argv[1], "parallel"))
		return run_parallel(argc, argv);
	if (!strcmp(argv[1], "record"))
		return run_record(argc, argv);
	if (!strcmp(argv[1], "exit"))
		return run_exit(argc, argv);
	return report("unknown helper mode");
}
