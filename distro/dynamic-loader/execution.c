// SPDX-License-Identifier: MIT
// Private execution support for the Wasm loader, not a public libc API.
#define _GNU_SOURCE
#include <errno.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <link.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

_Static_assert(sizeof(struct link_map) == 5 * sizeof(void *) &&
    sizeof(((struct link_map *)0)->l_addr) == sizeof(void *) &&
    offsetof(struct link_map, l_name) == sizeof(void *) &&
    offsetof(struct link_map, l_ld) == 2 * sizeof(void *) &&
    offsetof(struct link_map, l_next) == 3 * sizeof(void *) &&
    offsetof(struct link_map, l_prev) == 4 * sizeof(void *), "Wasm link_map execution ABI");

_Static_assert(sizeof(Dl_info) == 4 * sizeof(void *), "Wasm Dl_info execution ABI");
_Static_assert(offsetof(Dl_info, dli_fname) == 0 * sizeof(void *), "Wasm Dl_info filename ABI");
_Static_assert(offsetof(Dl_info, dli_fbase) == 1 * sizeof(void *), "Wasm Dl_info base ABI");
_Static_assert(offsetof(Dl_info, dli_sname) == 2 * sizeof(void *), "Wasm Dl_info symbol ABI");
_Static_assert(offsetof(Dl_info, dli_saddr) == 3 * sizeof(void *), "Wasm Dl_info symbol address ABI");

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(name)))
#else
#define EXPORT(name)
#endif

/* Fixed u64 slots avoid host guesses about off_t, dev_t, ino_t, padding or
 * pointer width. The host copies bytes out before releasing this descriptor.
 * A lease keeps this process-wide descriptor immutable from read through
 * release; a competing Worker gets its own TLS EBUSY descriptor.
 */
static uint64_t file[5]; /* data, size, device, inode, positive errno */
static char origin[PATH_MAX];
static int current_fd = -1;
static atomic_flag file_lease = ATOMIC_FLAG_INIT;
static _Thread_local int owns_file_lease;
static _Thread_local int file_lease_cancel_state;
static _Thread_local uint64_t busy_file[5];
static _Thread_local char busy_origin[1];

#ifdef __wasm__
__attribute__((import_module("linux_dlopen_v1"), import_name("link_map_abi")))
extern int dynamic_link_map_abi(void);
#endif

static uintptr_t private_read_error_descriptor(int error)
{
	memset(busy_file, 0, sizeof busy_file);
	busy_file[4] = error;
	busy_origin[0] = 0;
	return (uintptr_t)busy_file;
}

static void release_file_lease(void)
{
	if (!owns_file_lease) return;
	/* Linux close releases the descriptor even on EINTR; never retry it. */
	if (current_fd >= 0) (void)close(current_fd);
	current_fd = -1;
	free((void *)(uintptr_t)file[0]);
	for (unsigned i = 0; i < 5; i++) file[i] = 0;
	origin[0] = 0;
	owns_file_lease = 0;
	atomic_flag_clear_explicit(&file_lease, memory_order_release);
	/* A deferred cancellation requested during read() may run as soon as the
	 * caller's prior cancellation state is restored. The lease and every owned
	 * resource are already consistent before that point.
	 */
	(void)pthread_setcancelstate(file_lease_cancel_state, NULL);
}

EXPORT("__wasm_dlopen_io_v1")
int __wasm_dlopen_io_v1(void)
{
#ifdef __wasm__
	return dynamic_link_map_abi() == 1;
#else
	return 1;
#endif
}

EXPORT("__wasm_dlopen_read")
uintptr_t __wasm_dlopen_read(const char *path)
{
	/* The lease spans cancellation points in open/stat/read and remains held
	 * until the caller has copied the descriptor data. Disable cancellation
	 * before claiming it so cancellation cannot strand the process-wide lease.
	 */
	int caller_cancel_state;
	int cancel_error = pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &caller_cancel_state);
	if (cancel_error) return private_read_error_descriptor(cancel_error);
	if (atomic_flag_test_and_set_explicit(&file_lease, memory_order_acquire)) {
		uintptr_t result = private_read_error_descriptor(EBUSY);
		/* Do not touch the TLS state owned by a same-thread reentrant read. */
		(void)pthread_setcancelstate(caller_cancel_state, NULL);
		return result;
	}
	owns_file_lease = 1;
	file_lease_cancel_state = caller_cancel_state;
	for (unsigned i = 0; i < 5; i++) file[i] = 0;
	origin[0] = 0;
	current_fd = -1;
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	current_fd = fd;
	if (fd < 0) {
		file[4] = errno;
		if (errno == EBUSY) {
			uintptr_t result = private_read_error_descriptor(EBUSY);
			release_file_lease();
			return result;
		}
		return (uintptr_t)file;
	}
	struct stat status;
	struct statvfs filesystem;
	unsigned char *data = 0;
	int error = 0;
	if (fstat(fd, &status)) {
		error = errno;
		goto done;
	}
	file[2] = status.st_dev;
	file[3] = status.st_ino;
	if (fstatvfs(fd, &filesystem)) {
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
	if (!realpath(path, origin)) {
		error = errno;
		/* Anonymous and unlinked files remain openable through procfs even
		 * though their magic-link target has no filesystem pathname. Keep
		 * the descriptor pathname as the object's loader origin in that case.
		 * File identity and admission still come from the opened descriptor. */
		const char *number = !strncmp(path, "/proc/self/fd/", 14) ? path + 14 :
		                     !strncmp(path, "/dev/fd/", 8) ? path + 8 : 0;
		if (error != ENOENT || !number || !*number) goto done;
		for (const char *digit = number; *digit; digit++) {
			if (*digit < '0' || *digit > '9') goto done;
		}
		size_t length = strlen(path);
		if (length >= sizeof origin) {
			error = ENAMETOOLONG;
			goto done;
		}
		memcpy(origin, path, length + 1);
		error = 0;
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
	/* Keep the fd only until the host acquires the mm-owned kernel reference. */
	if (error) {
		free(data);
		if (error == EBUSY) {
			uintptr_t result = private_read_error_descriptor(EBUSY);
			release_file_lease();
			return result;
		}
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
	release_file_lease();
}

EXPORT("__wasm_dlopen_origin")
uintptr_t __wasm_dlopen_origin(void)
{
	return (uintptr_t)(owns_file_lease ? origin : busy_origin);
}

EXPORT("__wasm_dlopen_fd")
int __wasm_dlopen_fd(void) { return owns_file_lease ? current_fd : -1; }

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

EXPORT("__wasm_dlopen_main_path")
uintptr_t __wasm_dlopen_main_path(void)
{
	static const char empty_main_path[] = "";
	const char *path = program_invocation_name;
	return (uintptr_t)(path ? path : empty_main_path);
}

#ifdef __wasm__
__attribute__((import_module("linux_dlopen_v1"), import_name("abi")))
extern int dynamic_abi(void);
__attribute__((import_module("linux_dlopen_v1"), import_name("open")))
extern uintptr_t dynamic_open(const char *, int);
__attribute__((import_module("linux_dlopen_v1"), import_name("symbol")))
extern uintptr_t dynamic_symbol(uintptr_t, const char *);
__attribute__((import_module("linux_dlopen_v1"), import_name("valid")))
extern int dynamic_valid(uintptr_t);
__attribute__((import_module("linux_dlopen_v1"), import_name("error")))
extern int dynamic_error(char *, size_t);
__attribute__((import_module("linux_dlopen_v1"), import_name("address")))
extern int dynamic_address(uintptr_t pointer, uintptr_t info);
__attribute__((visibility("hidden"))) extern void __dl_seterr(const char *, ...);
static void report_error(void)
{
	char message[256] = "Wasm dynamic loader failure";
	(void)dynamic_error(message, sizeof message);
	__dl_seterr("%s", message);
}
__attribute__((visibility("hidden")))
void *__wasm_dynamic_open(const char *path, int flags)
{
	if (dynamic_abi() != 1) {
		__dl_seterr("Unsupported Wasm dynamic execution ABI");
		return 0;
	}
	uintptr_t handle = dynamic_open(path, flags);
	if (!handle) report_error();
	return (void *)handle;
}
__attribute__((visibility("hidden")))
void *__wasm_dynamic_symbol(void *handle, const char *name)
{
	uintptr_t address = dynamic_symbol((uintptr_t)handle, name);
	if (!address) report_error();
	return (void *)address;
}
__attribute__((visibility("hidden")))
int __wasm_dynamic_invalid(void *handle)
{
	if (dynamic_valid((uintptr_t)handle)) return 0;
	report_error();
	return 1;
}
__attribute__((visibility("hidden")))
int __wasm_dynamic_address(const void *pointer, Dl_info *info)
{
	return dynamic_address((uintptr_t)pointer, (uintptr_t)info);
}
#endif
