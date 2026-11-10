// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;

enum { input_bytes = 4 * 1024 * 1024, chunk_bytes = 64 * 1024 };

static const char *const input_path = "/tmp/xz-threads-input";
static const char *const compressed_path = "/tmp/xz-threads-output.xz";
static const char *const decoded_path = "/tmp/xz-threads-decoded";
static const char *const damaged_path = "/tmp/xz-threads-damaged.xz";

static void
fail(const char *operation)
{
	int saved_errno = errno;
	printf("::vm-test::fail: xz-threads: %s (errno=%d)\n",
		operation, saved_errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;)
		pause();
#else
	exit(1);
#endif
}

static void
require(int condition, const char *operation)
{
	if (!condition)
		fail(operation);
}

static int
open_output(const char *path)
{
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (fd < 0)
		fail("create output file");
	return fd;
}

static void
write_all(int fd, const void *buffer, size_t size)
{
	const unsigned char *cursor = buffer;
	while (size != 0) {
		ssize_t written = write(fd, cursor, size);
		if (written < 0 && errno == EINTR)
			continue;
		if (written <= 0) {
			if (written == 0)
				errno = EIO;
			fail("write output file");
		}
		cursor += written;
		size -= (size_t)written;
	}
}

static void
make_input(void)
{
	int fd = open_output(input_path);
	unsigned char buffer[chunk_bytes];
	uint32_t state = UINT32_C(0x8f31a2c7);
	size_t remaining = input_bytes;

	while (remaining != 0) {
		size_t count = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
		for (size_t i = 0; i < count; ++i) {
			state ^= state << 13;
			state ^= state >> 17;
			state ^= state << 5;
			buffer[i] = (unsigned char)state;
		}
		write_all(fd, buffer, count);
		remaining -= count;
	}

	if (close(fd) != 0)
		fail("close input file");
}

static ssize_t
read_retry(int fd, void *buffer, size_t size)
{
	ssize_t result;
	do {
		result = read(fd, buffer, size);
	} while (result < 0 && errno == EINTR);
	return result;
}

static void
compare_files(const char *left_path, const char *right_path)
{
	int left = open(left_path, O_RDONLY);
	if (left < 0)
		fail("open original for comparison");
	int right = open(right_path, O_RDONLY);
	if (right < 0)
		fail("open decoded file for comparison");
	unsigned char left_buffer[chunk_bytes];
	unsigned char right_buffer[chunk_bytes];

	for (;;) {
		ssize_t left_size = read_retry(left, left_buffer, sizeof(left_buffer));
		ssize_t right_size = read_retry(right, right_buffer, sizeof(right_buffer));
		if (left_size < 0 || right_size < 0)
			fail("read files for comparison");
		if (left_size != right_size ||
				(left_size != 0 && memcmp(left_buffer, right_buffer,
					(size_t)left_size) != 0)) {
			errno = EILSEQ;
			fail("round-trip bytes differ");
		}
		if (left_size == 0)
			break;
	}

	if (close(left) != 0 || close(right) != 0)
		fail("close compared files");
}

static void
spawn_to_file(const char *xz_path, char *const argv[], const char *stdout_path,
		pid_t *child)
{
	posix_spawn_file_actions_t actions;
	int error = posix_spawn_file_actions_init(&actions);
	if (error != 0) {
		errno = error;
		fail("initialize xz spawn file actions");
	}

	error = posix_spawn_file_actions_addopen(&actions, STDOUT_FILENO,
			stdout_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
	if (error == 0)
		error = posix_spawn(child, xz_path, &actions, NULL, argv, environ);
	int destroy_error = posix_spawn_file_actions_destroy(&actions);
	if (error != 0) {
		errno = error;
		fail("spawn xz");
	}
	if (destroy_error != 0) {
		errno = destroy_error;
		fail("destroy xz spawn file actions");
	}
}

static int
task_count(pid_t pid)
{
	char path[64];
	int length = snprintf(path, sizeof(path), "/proc/%" PRIdMAX "/task",
			(intmax_t)pid);
	if (length < 0 || (size_t)length >= sizeof(path)) {
		errno = ENAMETOOLONG;
		fail("format proc task path");
	}

	DIR *directory = opendir(path);
	if (directory == NULL) {
		if (errno == ENOENT)
			return 0;
		fail("open proc task list");
	}

	int count = 0;
	for (;;) {
		errno = 0;
		struct dirent *entry = readdir(directory);
		if (entry == NULL) {
			if (errno != 0)
				fail("read proc task list");
			break;
		}
		if (entry->d_name[0] >= '0' && entry->d_name[0] <= '9')
			++count;
	}

	if (closedir(directory) != 0)
		fail("close proc task list");
	return count;
}

static void
wait_success(pid_t child, const char *operation)
{
	int status;
	pid_t result;
	do {
		result = waitpid(child, &status, 0);
	} while (result < 0 && errno == EINTR);
	if (result < 0)
		fail("wait for xz");
	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		errno = ECHILD;
		fail(operation);
	}
}

static int
run_compression_and_observe(const char *xz_path)
{
	char *const argv[] = {
		(char *)xz_path,
		"--block-size=64KiB",
		"-T2",
		"-1",
		"-k",
		"-c",
		(char *)input_path,
		NULL,
	};
	pid_t child;
	spawn_to_file(xz_path, argv, compressed_path, &child);

	struct timespec start;
	if (clock_gettime(CLOCK_MONOTONIC, &start) != 0)
		fail("start compression deadline");
	const struct timespec delay = { .tv_sec = 0, .tv_nsec = 250000 };
	int peak_tasks = 0;
	int status = 0;
	for (;;) {
		pid_t result = waitpid(child, &status, WNOHANG);
		if (result == child)
			break;
		if (result < 0 && errno != EINTR)
			fail("poll xz compression");

		int current = task_count(child);
		if (current > peak_tasks)
			peak_tasks = current;

		struct timespec now;
		if (clock_gettime(CLOCK_MONOTONIC, &now) != 0)
			fail("check compression deadline");
		if (now.tv_sec - start.tv_sec > 120) {
			(void)kill(child, SIGKILL);
			(void)waitpid(child, &status, 0);
			errno = ETIMEDOUT;
			fail("xz compression timed out");
		}

		struct timespec remaining;
		if (nanosleep(&delay, &remaining) != 0 && errno != EINTR)
			fail("wait while observing xz workers");
	}

	if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
		errno = ECHILD;
		fail("xz threaded compression failed");
	}
	printf("xz-threads: -T2 compression reached %d process tasks\n", peak_tasks);
	if (peak_tasks < 3) {
		errno = EAGAIN;
		fail("-T2 did not expose the parent and two worker threads");
	}
	return peak_tasks;
}

static void
truncate_copy(const char *source, const char *destination)
{
	int input = open(source, O_RDONLY);
	if (input < 0)
		fail("open compressed stream for truncation");
	struct stat status;
	if (fstat(input, &status) != 0 || status.st_size < 2)
		fail("compressed stream is too short to damage");
	int output = open_output(destination);
	off_t remaining = status.st_size - 1;
	unsigned char buffer[chunk_bytes];
	while (remaining != 0) {
		size_t request = remaining < (off_t)sizeof(buffer)
				? (size_t)remaining : sizeof(buffer);
		ssize_t count = read_retry(input, buffer, request);
		if (count <= 0) {
			if (count == 0)
				errno = EIO;
			fail("read damaged stream source");
		}
		write_all(output, buffer, (size_t)count);
		remaining -= count;
	}
	if (close(input) != 0 || close(output) != 0)
		fail("close damaged stream files");
}

int
main(int argc, char **argv)
{
	const char *xz_path = argc > 1 ? argv[1] : "/usr/bin/xz";
	setvbuf(stdout, NULL, _IONBF, 0);
	printf("xz-threads: using %s\n", xz_path);

#ifdef __wasm__
	if (mkdir("/dev", 0755) != 0 && errno != EEXIST)
		fail("create devtmpfs mountpoint");
	if (mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) != 0 &&
			errno != EBUSY)
		fail("mount devtmpfs for null device");
#endif
	require(access("/dev/null", F_OK) == 0,
		"devtmpfs must provide /dev/null");

	if (access("/proc/self/task", F_OK) != 0) {
		if (mkdir("/proc", 0555) != 0 && errno != EEXIST)
			fail("create proc mountpoint");
		if (mount("proc", "/proc", "proc", 0, NULL) != 0)
			fail("mount proc for worker observation");
	}
	require(task_count(getpid()) == 1,
		"proc task list must expose the single test process");

	puts("xz-threads: generating deterministic multi-block input");
	make_input();
	(void)run_compression_and_observe(xz_path);

	puts("xz-threads: checking decompression round-trip");
	char *const decode_argv[] = {
		(char *)xz_path, "-d", "-c", (char *)compressed_path, NULL,
	};
	pid_t child;
	spawn_to_file(xz_path, decode_argv, decoded_path, &child);
	wait_success(child, "xz round-trip decompression failed");
	compare_files(input_path, decoded_path);

	puts("xz-threads: checking damaged stream rejection");
	truncate_copy(compressed_path, damaged_path);
	char *const damaged_argv[] = {
		(char *)xz_path, "-d", "-c", (char *)damaged_path, NULL,
	};
	spawn_to_file(xz_path, damaged_argv, "/dev/null", &child);
	int damaged_status;
	pid_t waited;
	do {
		waited = waitpid(child, &damaged_status, 0);
	} while (waited < 0 && errno == EINTR);
	if (waited < 0)
		fail("wait for damaged stream decoder");
	require(WIFEXITED(damaged_status) && WEXITSTATUS(damaged_status) == 1,
		"xz accepted a truncated stream");

	puts("xz-threads: checking recovery with a valid stream after the error");
	spawn_to_file(xz_path, decode_argv, decoded_path, &child);
	wait_success(child, "valid decode failed after damaged stream");
	compare_files(input_path, decoded_path);

	puts("::vm-test::pass");
#ifdef __wasm__
	for (;;)
		pause();
#endif
	return 0;
}
