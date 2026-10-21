/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

_Static_assert(offsetof(struct file_handle, f_handle) == 8, "file handle wire prefix");
static _Noreturn void fail(const char *what)
{
	printf("::vm-test::fail: file-handle: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}
static void require(int ok, const char *what)
{
	if (!ok) fail(what);
}
static void contents(int fd, const struct stat *original)
{
	char data[8] = {0};
	struct stat state;
	require(fstat(fd, &state) == 0 && state.st_dev == original->st_dev &&
	        state.st_ino == original->st_ino && state.st_size == 4,
	        "reopened inode identity");
	require(pread(fd, data, sizeof(data), 0) == 4 && !memcmp(data, "a\0bc", 4),
	        "reopened binary contents");
}
static void permission_check(int anchor, struct file_handle *handle)
{
	/* Linux capability ABI v3, two 32-bit words. Test-local wire definitions;
	 * no new libc wrapper or public header is required. */
	struct { uint32_t version; int pid; } header = {0x20080522, 0};
	struct capword { uint32_t effective, permitted, inheritable; } saved[2], reduced[2];
	require(syscall(SYS_capget, (long)&header, (long)saved, 0L, 0L, 0L, 0L) == 0 &&
	        (saved[0].effective & (1u << 2)), "initial CAP_DAC_READ_SEARCH");
	memcpy(reduced, saved, sizeof(saved));
	reduced[0].effective &= ~(1u << 2);
	require(syscall(SYS_capset, (long)&header, (long)reduced, 0L, 0L, 0L, 0L) == 0,
	        "temporarily remove effective decode capability");
	int fd = open_by_handle_at(anchor, handle, O_RDONLY);
	int error = errno;
	if (fd >= 0) close(fd);
	int restored = syscall(SYS_capset, (long)&header, (long)saved, 0L, 0L, 0L, 0L);
	require(restored == 0 && fd == -1 && error == EPERM, "decode permission enforced and restored");
}
int main(int argc, char **argv)
{
	/* A native host may lack an exportable filesystem or CAP_DAC_READ_SEARCH.
	 * Only native mode may report that limitation; Wasm must exercise all stages. */
	const char *base = argc > 1 ? argv[1] : "/tmp";
	char directory[512];
	int length = snprintf(directory, sizeof(directory), "%s/file-handle-XXXXXX", base);
	require(length > 0 && (size_t)length < sizeof(directory),
	        "temporary path");
	int complete = 0;
	require(mkdtemp(directory) != NULL, "temporary directory");
	int anchor = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	require(anchor >= 0, "mount anchor");
	int fd = openat(anchor, "before", O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
	require(fd >= 0 && write(fd, "a\0bc", 4) == 4, "create binary file");
	struct stat original;
	require(fstat(fd, &original) == 0, "initial inode");
	struct file_handle *handle = calloc(1, sizeof(*handle) + MAX_HANDLE_SZ);
	require(handle != NULL, "handle allocation");
	int mount_id = -1;
	int result = name_to_handle_at(anchor, "before", handle, &mount_id, 0);
#ifndef __wasm__
	if (result == -1 && (errno == EOPNOTSUPP || errno == ENOSYS)) {
		puts("file-handle: native filesystem cannot encode handles (target still required)");
		goto cleanup;
	}
#endif
	require(result == -1 && errno == EOVERFLOW && handle->handle_bytes > 0 &&
	        handle->handle_bytes <= MAX_HANDLE_SZ, "handle size discovery");
	unsigned size = handle->handle_bytes;
	require(name_to_handle_at(anchor, "before", handle, &mount_id, 0) == 0 &&
	        handle->handle_bytes == size && mount_id > 0, "encode handle and mount ID");
	struct file_handle *by_fd = calloc(1, sizeof(*by_fd) + MAX_HANDLE_SZ);
	require(by_fd != NULL, "second handle allocation");
	by_fd->handle_bytes = MAX_HANDLE_SZ;
	int fd_mount = -1;
	require(name_to_handle_at(fd, "", by_fd, &fd_mount, AT_EMPTY_PATH) == 0 &&
	        fd_mount == mount_id && by_fd->handle_type == handle->handle_type &&
	        by_fd->handle_bytes == size && !memcmp(by_fd->f_handle, handle->f_handle, size),
	        "descriptor handle matches path");
	free(by_fd);
	require(renameat(anchor, "before", anchor, "after") == 0, "rename encoded file");
	int reopened = open_by_handle_at(anchor, handle, O_RDONLY | O_CLOEXEC);
#ifndef __wasm__
	if (reopened == -1 && (errno == EPERM || errno == EACCES)) {
		puts("file-handle: encoding and rename pass; native decode privilege unavailable (target still required)");
		goto cleanup;
	}
#endif
	require(reopened >= 0 && (fcntl(reopened, F_GETFD) & FD_CLOEXEC), "reopen renamed handle");
	contents(reopened, &original);
	require(close(reopened) == 0, "close first reopen");
	puts("file-handle: size discovery, descriptor encoding and rename reopen pass");

	unsigned saved_size = handle->handle_bytes;
	handle->handle_bytes = 0;
	require(open_by_handle_at(anchor, handle, O_RDONLY) == -1 && errno == EINVAL,
	        "zero length rejected");
	handle->handle_bytes = MAX_HANDLE_SZ + 1;
	require(open_by_handle_at(anchor, handle, O_RDONLY) == -1 && errno == EINVAL,
	        "oversized handle rejected");
	handle->handle_bytes = saved_size;
	require(open_by_handle_at(-1, handle, O_RDONLY) == -1 && errno == EBADF,
	        "bad anchor rejected");
	int saved_type = handle->handle_type;
	handle->handle_type = -1;
	require(open_by_handle_at(anchor, handle, O_RDONLY) == -1 && errno == EINVAL,
	        "invalid handle type rejected");
	handle->handle_type = saved_type;
	permission_check(anchor, handle);
	contents(fd, &original);
	reopened = open_by_handle_at(anchor, handle, O_RDONLY);
	require(reopened >= 0, "valid reopen after errors");
	contents(reopened, &original);
	require(close(reopened) == 0, "close recovery reopen");
	puts("file-handle: invalid handles, decode permissions and recovery preserve file pass");

	require(unlinkat(anchor, "after", 0) == 0, "unlink encoded inode");
	contents(fd, &original);
	require(close(fd) == 0, "release last file reference");
	fd = -1;
	require(open_by_handle_at(anchor, handle, O_RDONLY) == -1 && errno == ESTALE,
	        "deleted inode handle is stale");
	puts("file-handle: unlink descriptor lifetime and stale handle refusal pass");
	complete = 1;
	goto cleanup;
cleanup:
	if (fd >= 0) require(close(fd) == 0, "close file");
	if (unlinkat(anchor, "before", 0)) require(errno == ENOENT, "cleanup old name");
	if (unlinkat(anchor, "after", 0)) require(errno == ENOENT, "cleanup new name");
	require(close(anchor) == 0 && rmdir(directory) == 0, "cleanup directory");
	free(handle);
	if (complete) puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
