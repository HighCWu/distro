/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: memfd: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

static long create_memfd(const char *name, unsigned flags)
{
	/* Pass the syscall number and all six machine-word argument slots. */
	return syscall(SYS_memfd_create, (long)name, (long)flags,
	               0L, 0L, 0L, 0L);
}

static void check_memfd(unsigned flags, const char *name)
{
	static const unsigned char payload[] = {
		'm', 'e', 'm', 'f', 'd', 0, 'w', 'a', 's', 'm', '6', '4', '\n',
	};
	unsigned char received[sizeof(payload)];
	long result = create_memfd(name, flags);
	if (result < 0)
		fail("memfd_create failed");
	int fd = (int)result;

	struct stat status;
	if (fstat(fd, &status) != 0)
		fail("fstat on new descriptor failed");
	if (status.st_size != 0)
		fail("new file did not start empty");

	int descriptor_flags = fcntl(fd, F_GETFD);
	if (descriptor_flags < 0)
		fail("F_GETFD failed");
	if (((descriptor_flags & FD_CLOEXEC) != 0) != ((flags & MFD_CLOEXEC) != 0))
		fail("FD_CLOEXEC did not match creation flags");

	if (write(fd, payload, sizeof(payload)) != (ssize_t)sizeof(payload))
		fail("writing payload failed");
	if (lseek(fd, 0, SEEK_SET) != 0)
		fail("rewinding file failed");
	if (read(fd, received, sizeof(received)) != (ssize_t)sizeof(received) ||
	    memcmp(received, payload, sizeof(payload)) != 0)
		fail("read payload did not match written bytes");

	if (ftruncate(fd, 0) != 0)
		fail("truncating file failed");
	if (fstat(fd, &status) != 0)
		fail("fstat after truncate failed");
	if (status.st_size != 0)
		fail("ftruncate did not clear file size");
	if (close(fd) != 0)
		fail("closing descriptor failed");
}

int main(void)
{
	check_memfd(0, "memfd-no-cloexec");
	check_memfd(MFD_CLOEXEC, "memfd-cloexec");

	errno = 0;
	long invalid = create_memfd("memfd-invalid-flags", 0x80000000U);
	if (invalid >= 0) {
		close((int)invalid);
		fail("unknown creation flags were accepted");
	}
	if (errno != EINVAL)
		fail("unknown creation flags did not fail with EINVAL");

	puts("memfd: creation flags, file I/O, truncate and close verified");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
