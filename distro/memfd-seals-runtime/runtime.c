// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "memfd-seals-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void test_basic_seals(void)
{
	int fd = memfd_create("seals-test", MFD_CLOEXEC | MFD_ALLOW_SEALING);
	require(fd >= 0, "memfd_create(MFD_CLOEXEC | MFD_ALLOW_SEALING)");

	int fd_flags = fcntl(fd, F_GETFD);
	require(fd_flags >= 0 && (fd_flags & FD_CLOEXEC) != 0,
		"memfd has FD_CLOEXEC");
	require(fcntl(fd, F_GET_SEALS) == 0, "initial F_GET_SEALS is 0");

	const char *payload = "hello-memfd";
	size_t len = strlen(payload);
	require(pwrite(fd, payload, len, 0) == (ssize_t)len, "pwrite payload");

	struct stat st;
	require(ftruncate(fd, 16) == 0 && fstat(fd, &st) == 0 &&
			st.st_size == 16,
		"ftruncate grow to 16");
	require(ftruncate(fd, (off_t)len) == 0 && fstat(fd, &st) == 0 &&
			st.st_size == (off_t)len,
		"ftruncate shrink back to 11");

	char buf[32] = { 0 };
	require(lseek(fd, 0, SEEK_SET) == 0, "lseek to 0");
	require(pread(fd, buf, sizeof(buf) - 1, 0) == (ssize_t)len,
		"pread payload");
	require(strcmp(buf, payload) == 0, "pread payload matches");

	/* F_SEAL_SHRINK blocks shrinking, allows growing. */
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK) == 0,
		"add F_SEAL_SHRINK");
	require(fcntl(fd, F_GET_SEALS) == F_SEAL_SHRINK,
		"F_GET_SEALS == F_SEAL_SHRINK");
	errno = 0;
	require(ftruncate(fd, 4) == -1 && errno == EPERM,
		"ftruncate shrink fails with EPERM under F_SEAL_SHRINK");
	require(ftruncate(fd, 16) == 0 && fstat(fd, &st) == 0 &&
			st.st_size == 16,
		"ftruncate grow succeeds under F_SEAL_SHRINK");

	/* F_SEAL_GROW blocks growing and extending writes. */
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_GROW) == 0, "add F_SEAL_GROW");
	require(fcntl(fd, F_GET_SEALS) == (F_SEAL_SHRINK | F_SEAL_GROW),
		"F_GET_SEALS == F_SEAL_SHRINK | F_SEAL_GROW");
	errno = 0;
	require(ftruncate(fd, 32) == -1 && errno == EPERM,
		"ftruncate grow fails with EPERM under F_SEAL_GROW");
	errno = 0;
	require(pwrite(fd, "!", 1, 16) == -1 && errno == EPERM,
		"extending pwrite fails with EPERM under F_SEAL_GROW");

	/* F_SEAL_WRITE blocks all writes and ftruncate, keeps reads working. */
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE) == 0, "add F_SEAL_WRITE");
	require(fcntl(fd, F_GET_SEALS) ==
			(F_SEAL_SHRINK | F_SEAL_GROW | F_SEAL_WRITE),
		"F_GET_SEALS includes F_SEAL_WRITE");
	errno = 0;
	require(pwrite(fd, "X", 1, 0) == -1 && errno == EPERM,
		"pwrite fails with EPERM under F_SEAL_WRITE");
	errno = 0;
	require(write(fd, "X", 1) == -1 && errno == EPERM,
		"write fails with EPERM under F_SEAL_WRITE");
	errno = 0;
	require(ftruncate(fd, 16) == -1 && errno == EPERM,
		"ftruncate fails with EPERM under F_SEAL_WRITE");

	memset(buf, 0, sizeof(buf));
	require(pread(fd, buf, len, 0) == (ssize_t)len &&
			strcmp(buf, payload) == 0,
		"pread still succeeds under F_SEAL_WRITE");

	/* F_SEAL_SEAL blocks subsequent F_ADD_SEALS. */
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_SEAL) == 0, "add F_SEAL_SEAL");
	errno = 0;
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_SHRINK) == -1 && errno == EPERM,
		"F_ADD_SEALS fails with EPERM under F_SEAL_SEAL");
	require(close(fd) == 0, "close sealed memfd");
}

static void test_unsealable_default(void)
{
	int fd = memfd_create("no-seals", MFD_CLOEXEC);
	require(fd >= 0, "memfd_create without MFD_ALLOW_SEALING");
	require(fcntl(fd, F_GET_SEALS) == F_SEAL_SEAL,
		"default seals without MFD_ALLOW_SEALING is F_SEAL_SEAL");
	errno = 0;
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE) == -1 && errno == EPERM,
		"F_ADD_SEALS rejected when MFD_ALLOW_SEALING omitted");
	require(close(fd) == 0, "close unsealable memfd");
}

#ifdef F_SEAL_FUTURE_WRITE
static void test_future_write_seal(void)
{
	int fd = memfd_create("future-write", MFD_CLOEXEC | MFD_ALLOW_SEALING);
	require(fd >= 0, "memfd_create for F_SEAL_FUTURE_WRITE");

	const char *initial = "init-data";
	require(pwrite(fd, initial, strlen(initial), 0) ==
			(ssize_t)strlen(initial),
		"pwrite initial data");
	require(fcntl(fd, F_ADD_SEALS, F_SEAL_FUTURE_WRITE) == 0,
		"add F_SEAL_FUTURE_WRITE");

	/* Existing writable fd can still write. */
	require(pwrite(fd, "INIT", 4, 0) == 4,
		"existing writable fd still writes under F_SEAL_FUTURE_WRITE");

	char proc_path[64];
	int n = snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", fd);
	require(n > 0 && (size_t)n < sizeof(proc_path), "format /proc/self/fd");

	/* New read-only open works, while new writable open is rejected. */
	errno = 0;
	int wr_fd = open(proc_path, O_RDWR);
	if (wr_fd >= 0) {
		close(wr_fd);
		require(0, "new O_RDWR open rejected under F_SEAL_FUTURE_WRITE");
	}
	require(errno == EPERM || errno == EACCES || errno == ENOENT,
		"O_RDWR open under F_SEAL_FUTURE_WRITE fails cleanly");

	int ro_fd = open(proc_path, O_RDONLY);
	if (ro_fd >= 0) {
		char buf[32] = { 0 };
		require(pread(ro_fd, buf, strlen(initial), 0) ==
					(ssize_t)strlen(initial) &&
				strcmp(buf, "INIT-data") == 0,
			"new O_RDONLY open reads updated data");
		require(close(ro_fd) == 0, "close ro_fd");
	} else {
		char buf[32] = { 0 };
		require(pread(fd, buf, strlen(initial), 0) ==
					(ssize_t)strlen(initial) &&
				strcmp(buf, "INIT-data") == 0,
			"pread updated data on original fd");
	}

	require(close(fd) == 0, "close future-write memfd");
}
#endif

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	test_basic_seals();
	test_unsealable_default();
#ifdef F_SEAL_FUTURE_WRITE
	test_future_write_seal();
#endif

	puts("memfd seals runtime: MFD_ALLOW_SEALING, shrink/grow/write/seal and default F_SEAL_SEAL pass");
	return 0;
}
