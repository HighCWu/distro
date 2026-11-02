// SPDX-License-Identifier: MIT
// Native failure injection for the private bridge; not Wasm execution evidence.
#define _GNU_SOURCE
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/statvfs.h>
#include <unistd.h>

static int interrupt_read, eof_read, fail_allocation, noexec, secure;
static ssize_t bridge_read(int fd, void *bytes, size_t size)
{
	if (interrupt_read) {
		interrupt_read = 0;
		errno = EINTR;
		return -1;
	}
	return eof_read ? 0 : read(fd, bytes, size);
}
static void *bridge_malloc(size_t size)
{
	return fail_allocation ? 0 : malloc(size);
}
static int bridge_statvfs(int fd, struct statvfs *status)
{
	int result = fstatvfs(fd, status);
	if (!result && noexec) status->f_flag |= ST_NOEXEC;
	return result;
}
static unsigned long bridge_aux(unsigned long type)
{
	return secure && type == AT_SECURE ? 1 : getauxval(type);
}
#define read bridge_read
#define malloc bridge_malloc
#define fstatvfs bridge_statvfs
#define getauxval bridge_aux
#include "execution.c"
#undef read
#undef malloc
#undef fstatvfs
#undef getauxval

static int descriptor_count(void)
{
	DIR *directory = opendir("/proc/self/fd");
	assert(directory);
	int count = 0;
	while (readdir(directory)) count++;
	assert(!closedir(directory));
	return count;
}
static void rejection(const char *path, unsigned error)
{
	uint64_t *result = (void *)__wasm_dlopen_read(path);
	assert(!result[0] && result[4] == error);
	__wasm_dlopen_read_release();
}
int main(int argc, char **argv)
{
	assert(argc == 5 && __wasm_dlopen_io_v1() == 1);
	int baseline = descriptor_count();
	interrupt_read = 1;
	uint64_t *result = (void *)__wasm_dlopen_read(argv[1]);
	assert(!result[4] && result[0] && result[1] == 25);
	assert(!memcmp((void *)(uintptr_t)result[0], "private loader file bytes", 25));
	uint64_t device = result[2], inode = result[3], pointer = result[0];
	assert(descriptor_count() == baseline);
	/* An overlapping request may not discard the still-owned first buffer. */
	result = (void *)__wasm_dlopen_read(argv[1]);
	assert(result[4] == EBUSY && result[0] == pointer);
	__wasm_dlopen_read_release();
	result = (void *)__wasm_dlopen_read(argv[2]);
	assert(!result[4] && result[2] == device && result[3] == inode);
	__wasm_dlopen_read_release();
	rejection(argv[3], EFBIG); /* Empty regular file. */
	rejection(argv[4], ENOENT);
	noexec = 1;
	rejection(argv[1], EACCES);
	noexec = 0;
	eof_read = 1;
	rejection(argv[1], EIO);
	eof_read = 0;
	fail_allocation = 1;
	rejection(argv[1], ENOMEM);
	fail_allocation = 0;
	result = (void *)__wasm_dlopen_read(argv[1]);
	assert(!result[4] && result[0]);
	__wasm_dlopen_read_release();
	assert(descriptor_count() == baseline);
	uintptr_t allocation = __wasm_dlopen_allocate(128, 64);
	assert(allocation && !(allocation & 63));
	memset((void *)allocation, 0x5a, 128);
	__wasm_dlopen_deallocate(allocation);
	assert(!__wasm_dlopen_allocate(128, 3));
	assert(!__wasm_dlopen_allocate(0, 16));
	assert(!setenv("LD_LIBRARY_PATH", "/lib/bridge-test", 1));
	assert(!strcmp((void *)__wasm_dlopen_library_path(), "/lib/bridge-test"));
	secure = 1;
	assert(!__wasm_dlopen_library_path());
	return 0;
}
