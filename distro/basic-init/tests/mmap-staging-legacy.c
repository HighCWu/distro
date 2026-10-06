/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "test.h"
#include <unistd.h>

int main(void)
{
	/* Dedicated test kernel, but this module deliberately has no new export.
	 * The host must return ENOSYS rather than silently use anonymous mmap. */
	for (int i = 0; i < 32; i++) {
		errno = 0;
		if (syscall(253, (unsigned long)1) != -1 || errno != ENOSYS)
			test_fail("legacy module accepted staging copy");
	}
	test_pass();
}
