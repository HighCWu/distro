#define _GNU_SOURCE
#include "test.h"

#include <stdint.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>

static void expect_failure(long result, int expected_errno, const char *message)
{
	if (result != -1 || errno != expected_errno)
		test_fail(message);
}

int main(void)
{
	size_t page_size = (size_t)sysconf(_SC_PAGESIZE);
	size_t length = 3 * page_size;
	unsigned char *mapping;
	unsigned char *raw;

	if (page_size == (size_t)-1 || !page_size || (page_size & (page_size - 1)))
		test_perror("sysconf(_SC_PAGESIZE)");

	mapping = mmap(0, page_size, PROT_READ | PROT_WRITE,
		       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (mapping == MAP_FAILED)
		test_perror("mmap");
	if ((uintptr_t)mapping & (page_size - 1))
		test_fail("libc mmap result is not page aligned");
	for (size_t i = 0; i < page_size; i++)
		if (mapping[i])
			test_fail("libc mmap result is not zero filled");
	mapping[0] = 0x5a;
	mapping[page_size - 1] = 0xa5;
	if (munmap(mapping, page_size))
		test_perror("munmap");

	raw = (void *)syscall(SYS_mmap, 0, length, PROT_READ | PROT_WRITE,
			      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
	if (raw == MAP_FAILED)
		test_perror("raw SYS_mmap");
	if ((uintptr_t)raw & (page_size - 1))
		test_fail("raw SYS_mmap result is not page aligned");
	for (size_t i = 0; i < length; i++)
		if (raw[i])
			test_fail("raw SYS_mmap result is not zero filled");
	raw[0] = 0x11;
	raw[page_size] = 0x22;
	raw[length - 1] = 0x33;

	if (syscall(SYS_munmap, raw + page_size, page_size))
		test_perror("raw partial SYS_munmap");
	if (munmap(raw, page_size))
		test_perror("partial munmap prefix");
	if (syscall(SYS_munmap, raw + 2 * page_size, page_size))
		test_perror("raw partial SYS_munmap suffix");

	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, page_size, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0),
		       ENOMEM, "MAP_FIXED did not fail with ENOMEM");
	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, page_size, PROT_READ,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0),
		       EINVAL, "unsupported protection did not fail with EINVAL");
	errno = 0;
	expect_failure(syscall(SYS_mmap, 0, 0, PROT_READ | PROT_WRITE,
			       MAP_PRIVATE | MAP_ANONYMOUS, -1, 0),
		       EINVAL, "zero-length mapping did not fail with EINVAL");

	test_pass();
}
