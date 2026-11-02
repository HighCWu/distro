// SPDX-License-Identifier: MIT
// Private execution support for the Wasm loader, not a public libc API.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/auxv.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(name)))
#else
#define EXPORT(name)
#endif

/* Fixed u64 slots avoid host guesses about off_t, dev_t, ino_t, padding or
 * pointer width. The host copies bytes out before releasing this descriptor.
 * Only one read may be outstanding; reentrant loading is a process-loader job.
 */
static uint64_t file[5]; /* data, size, device, inode, positive errno */

EXPORT("__wasm_dlopen_io_v1")
int __wasm_dlopen_io_v1(void)
{
	return 1;
}

EXPORT("__wasm_dlopen_read")
uintptr_t __wasm_dlopen_read(const char *path)
{
	if (file[0]) {
		file[4] = EBUSY;
		return (uintptr_t)file;
	}
	for (unsigned i = 0; i < 5; i++) file[i] = 0;
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0) {
		file[4] = errno;
		return (uintptr_t)file;
	}
	struct stat status;
	struct statvfs filesystem;
	unsigned char *data = 0;
	int error = 0;
	if (fstat(fd, &status) || fstatvfs(fd, &filesystem)) {
		error = errno;
		goto done;
	}
	if (!S_ISREG(status.st_mode)) {
		error = EINVAL;
		goto done;
	}
	if (filesystem.f_flag & ST_NOEXEC) {
		error = EACCES;
		goto done;
	}
	/* Per-file loader admission, not a Linux file-size or mmap limit. */
	if (status.st_size <= 0 || (uint64_t)status.st_size > 64 * 1024 * 1024) {
		error = EFBIG;
		goto done;
	}
	size_t size = status.st_size;
	data = malloc(size);
	if (!data) {
		error = ENOMEM;
		goto done;
	}
	for (size_t offset = 0; offset < size;) {
		ssize_t count = read(fd, data + offset, size - offset);
		if (count < 0 && errno == EINTR) continue;
		if (count <= 0) {
			error = count < 0 ? errno : EIO;
			goto done;
		}
		offset += count;
	}
done:
	/* Linux close is never retried after EINTR: the descriptor may be reused. */
	if (close(fd) && !error) error = errno;
	if (error) {
		free(data);
		file[4] = error;
	} else {
		file[0] = (uintptr_t)data;
		file[1] = status.st_size;
		file[2] = status.st_dev;
		file[3] = status.st_ino;
	}
	return (uintptr_t)file;
}

EXPORT("__wasm_dlopen_read_release")
void __wasm_dlopen_read_release(void)
{
	free((void *)(uintptr_t)file[0]);
	for (unsigned i = 0; i < 5; i++) file[i] = 0;
}

EXPORT("__wasm_dlopen_allocate")
uintptr_t __wasm_dlopen_allocate(size_t size, size_t alignment)
{
	void *pointer = 0;
	if (!alignment || (alignment & (alignment - 1))) return 0;
	if (alignment < sizeof(void *)) alignment = sizeof(void *);
	if (!size || posix_memalign(&pointer, alignment, size)) return 0;
	return (uintptr_t)pointer;
}

EXPORT("__wasm_dlopen_deallocate")
void __wasm_dlopen_deallocate(uintptr_t pointer)
{
	free((void *)pointer);
}

EXPORT("__wasm_dlopen_library_path")
uintptr_t __wasm_dlopen_library_path(void)
{
	/* Follow normal secure-execution policy rather than bypassing Linux path
	 * permissions through host fetch or honoring an unsafe environment search. */
	if (getauxval(AT_SECURE) || getuid() != geteuid() || getgid() != getegid())
		return 0;
	return (uintptr_t)getenv("LD_LIBRARY_PATH");
}
