// SPDX-License-Identifier: MIT
// Native failure injection for the private bridge; not Wasm execution evidence.
#define _GNU_SOURCE
#include <assert.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>
#include <pthread.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/statvfs.h>
#include <sys/mman.h>
#include <unistd.h>

static int interrupt_read, eof_read, fail_allocation, noexec, secure;
static pthread_mutex_t read_gate_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t read_gate_condition = PTHREAD_COND_INITIALIZER;
static int pause_next_read, paused_read, resume_read;

static ssize_t bridge_read(int fd, void *bytes, size_t size)
{
	pthread_mutex_lock(&read_gate_mutex);
	if (pause_next_read) {
		pause_next_read = 0;
		paused_read = 1;
		pthread_cond_broadcast(&read_gate_condition);
		while (!resume_read) pthread_cond_wait(&read_gate_condition, &read_gate_mutex);
	}
	pthread_mutex_unlock(&read_gate_mutex);
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

struct parallel_read {
	const char *path;
	int succeeded;
};

static void *parallel_owner_read(void *opaque)
{
	struct parallel_read *request = opaque;
	uint64_t *result = (void *)__wasm_dlopen_read(request->path);
	if (!result[4] && result[0] && result[1] == 25 &&
	    !memcmp((void *)(uintptr_t)result[0], "private loader file bytes", 25) &&
	    __wasm_dlopen_fd() >= 0 && !strcmp((const char *)__wasm_dlopen_origin(), request->path))
		request->succeeded = 1;
	__wasm_dlopen_read_release();
	return request->succeeded ? 0 : (void *)(uintptr_t)1;
}

static void *cancelled_owner_read(void *opaque)
{
	const char *path = opaque;
	uint64_t *result = (void *)__wasm_dlopen_read(path);
	if (result[4] || !result[0] || result[1] != 25 ||
	    memcmp((void *)(uintptr_t)result[0], "private loader file bytes", 25))
		return (void *)(uintptr_t)1;
	__wasm_dlopen_read_release();
	/* The owner restores cancellation only after releasing the lease. */
	pthread_testcancel();
	return 0;
}

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
	assert(descriptor_count() == baseline + 1 && __wasm_dlopen_fd() >= 0);
	/* An overlapping request may not discard the still-owned first buffer. */
	uint64_t *busy = (void *)__wasm_dlopen_read(argv[1]);
	assert(busy[4] == EBUSY && !busy[0] && busy != result);
	assert(result[4] == 0 && result[0] == pointer && __wasm_dlopen_fd() >= 0);
	__wasm_dlopen_read_release();
	assert(descriptor_count() == baseline);
	result = (void *)__wasm_dlopen_read(argv[2]);
	assert(!result[4] && result[2] == device && result[3] == inode);
	__wasm_dlopen_read_release();

	/* A concurrent Worker gets a private EBUSY record without changing the
	 * active owner's fd, origin, file bytes, or later release operation. */
	pthread_mutex_lock(&read_gate_mutex);
	pause_next_read = 1;
	paused_read = 0;
	resume_read = 0;
	pthread_mutex_unlock(&read_gate_mutex);
	struct parallel_read parallel = { .path = argv[1] };
	pthread_t reader;
	assert(!pthread_create(&reader, 0, parallel_owner_read, &parallel));
	pthread_mutex_lock(&read_gate_mutex);
	while (!paused_read) pthread_cond_wait(&read_gate_condition, &read_gate_mutex);
	pthread_mutex_unlock(&read_gate_mutex);
	assert(current_fd >= 0 && file[4] == 0);
	busy = (void *)__wasm_dlopen_read(argv[2]);
	assert(busy[4] == EBUSY && !busy[0] && busy != file);
	const char *nonowner_origin = (const char *)(uintptr_t)__wasm_dlopen_origin();
	assert(__wasm_dlopen_fd() == -1 && !nonowner_origin[0]);
	__wasm_dlopen_read_release(); /* A non-owner cannot release the lease. */
	assert(current_fd >= 0 && file[4] == 0 && descriptor_count() == baseline + 1);
	pthread_mutex_lock(&read_gate_mutex);
	resume_read = 1;
	pthread_cond_broadcast(&read_gate_condition);
	pthread_mutex_unlock(&read_gate_mutex);
	void *parallel_result = (void *)(uintptr_t)1;
	assert(!pthread_join(reader, &parallel_result));
	assert(!parallel_result && parallel.succeeded && descriptor_count() == baseline);

	/* Cancellation requested while the owner is blocked in read() must remain
	 * deferred until read_release has freed the descriptor and lease.
	 */
	pthread_mutex_lock(&read_gate_mutex);
	pause_next_read = 1;
	paused_read = 0;
	resume_read = 0;
	pthread_mutex_unlock(&read_gate_mutex);
	pthread_t cancelled_reader;
	assert(!pthread_create(&cancelled_reader, 0, cancelled_owner_read, (void *)argv[1]));
	pthread_mutex_lock(&read_gate_mutex);
	while (!paused_read) pthread_cond_wait(&read_gate_condition, &read_gate_mutex);
	pthread_mutex_unlock(&read_gate_mutex);
	assert(!pthread_cancel(cancelled_reader));
	pthread_mutex_lock(&read_gate_mutex);
	resume_read = 1;
	pthread_cond_broadcast(&read_gate_condition);
	pthread_mutex_unlock(&read_gate_mutex);
	void *cancelled_result = 0;
	assert(!pthread_join(cancelled_reader, &cancelled_result));
	assert(cancelled_result == PTHREAD_CANCELED && descriptor_count() == baseline);
	result = (void *)__wasm_dlopen_read(argv[1]);
	assert(!result[4] && result[0] && result[1] == 25);
	__wasm_dlopen_read_release();
	assert(descriptor_count() == baseline);

	char raw_name[PATH_MAX];
	int raw_length = snprintf(raw_name, sizeof raw_name, "%s-\200-\355\240\200", argv[1]);
	assert(raw_length > 0 && (size_t)raw_length < sizeof raw_name && !link(argv[1], raw_name));
	result = (void *)__wasm_dlopen_read(raw_name);
	assert(!result[4] && result[2] == device && result[3] == inode &&
	       !strcmp((const char *)__wasm_dlopen_origin(), raw_name));
	__wasm_dlopen_read_release();
	assert(!unlink(raw_name) && descriptor_count() == baseline);
	int anonymous = memfd_create("loader-origin", MFD_CLOEXEC);
	assert(anonymous >= 0 && write(anonymous, "anonymous", 9) == 9);
	char descriptor_path[64];
	int path_length = snprintf(descriptor_path, sizeof descriptor_path, "/proc/self/fd/%d", anonymous);
	assert(path_length > 0 && (size_t)path_length < sizeof descriptor_path);
	result = (void *)__wasm_dlopen_read(descriptor_path);
	assert(!result[4] && result[1] == 9 && !memcmp((void *)(uintptr_t)result[0], "anonymous", 9));
	assert(!strcmp((const char *)__wasm_dlopen_origin(), descriptor_path));
	__wasm_dlopen_read_release();
	assert(!close(anonymous) && descriptor_count() == baseline);
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
