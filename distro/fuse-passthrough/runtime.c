/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fuse.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static void fail(const char *message)
{
	printf("::vm-test::fail: %s errno=%d\n", message, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(condition, message) do { if (!(condition)) fail(message); } while (0)

struct server {
	int fd;
	int released[2];
	atomic_int backing, data_requests, stopping, releases;
};

static void reply(int fd, uint64_t unique, int error, const void *payload, size_t length)
{
	unsigned char bytes[sizeof(struct fuse_out_header) + sizeof(struct fuse_init_out) +
			    sizeof(struct fuse_entry_out)];
	struct fuse_out_header header = { .len = sizeof(header) + length,
		.error = -error, .unique = unique };
	CHECK(sizeof(header) + length <= sizeof(bytes), "reply bound");
	memcpy(bytes, &header, sizeof(header));
	if (length) memcpy(bytes + sizeof(header), payload, length);
	ssize_t sent;
	do sent = write(fd, bytes, header.len); while (sent < 0 && errno == EINTR);
	CHECK(sent == (ssize_t)header.len, "complete FUSE reply");
}

static struct fuse_attr attr(uint64_t node)
{
	struct fuse_attr value = { .ino = node, .size = node == 1 ? 0 : 8,
		.mode = node == 1 ? S_IFDIR | 0755 : S_IFREG | 0600,
		.nlink = node == 1 ? 2 : 1, .blksize = 65536 };
	return value;
}

static void *serve(void *argument)
{
	struct server *state = argument;
	const size_t capacity = 2 * 65536;
	unsigned char *bytes = malloc(capacity);
	CHECK(bytes, "server request allocation");
	for (;;) {
		ssize_t size = read(state->fd, bytes, capacity);
		if (size < 0 && errno == EINTR) continue;
		if (size < 0 && errno == ENODEV && atomic_load(&state->stopping)) break;
		CHECK(size >= (ssize_t)sizeof(struct fuse_in_header), "FUSE request header");
		struct fuse_in_header input;
		memcpy(&input, bytes, sizeof(input));
		CHECK(input.len == (uint32_t)size, "single complete FUSE request");
		switch (input.opcode) {
		case FUSE_INIT: {
			struct fuse_init_in request;
			CHECK(size >= (ssize_t)(sizeof(input) + sizeof(request)), "extended init request");
			memcpy(&request, bytes + sizeof(input), sizeof(request));
			CHECK(request.major == FUSE_KERNEL_VERSION && request.minor >= 40 &&
			      (request.flags & FUSE_INIT_EXT) &&
			      (request.flags2 & (FUSE_PASSTHROUGH >> 32)), "passthrough negotiation offered");
			struct fuse_init_out response = { .major = FUSE_KERNEL_VERSION,
				.minor = 40, .flags = FUSE_INIT_EXT, .flags2 = FUSE_PASSTHROUGH >> 32,
				.max_write = 4096, .time_gran = 1, .max_stack_depth = 1 };
			reply(state->fd, input.unique, 0, &response, sizeof(response));
			CHECK(write(state->released[1], "I", 1) == 1, "init reply acknowledgement");
			break;
		}
		case FUSE_LOOKUP: {
			const char *name = (char *)bytes + sizeof(input);
			CHECK(size > (ssize_t)sizeof(input) && bytes[size - 1] == 0, "bounded lookup name");
			if (input.nodeid != 1 || strcmp(name, "file")) {
				reply(state->fd, input.unique, ENOENT, NULL, 0);
				break;
			}
			struct fuse_entry_out response = { .nodeid = 2, .generation = 1, .attr = attr(2) };
			reply(state->fd, input.unique, 0, &response, sizeof(response));
			break;
		}
		case FUSE_GETATTR: {
			struct fuse_attr_out response = { .attr = attr(input.nodeid) };
			reply(state->fd, input.unique, 0, &response, sizeof(response));
			break;
		}
		case FUSE_OPEN: {
			struct fuse_open_out response = { .fh = 1, .open_flags = FOPEN_PASSTHROUGH,
				.backing_id = atomic_load(&state->backing) };
			CHECK(response.backing_id > 0, "backing registered before open");
			reply(state->fd, input.unique, 0, &response, sizeof(response));
			break;
		}
		case FUSE_READ:
		case FUSE_WRITE:
			atomic_fetch_add(&state->data_requests, 1);
			reply(state->fd, input.unique, EIO, NULL, 0);
			break;
		case FUSE_RELEASE:
			reply(state->fd, input.unique, 0, NULL, 0);
			atomic_fetch_add(&state->releases, 1);
			CHECK(write(state->released[1], "R", 1) == 1, "release acknowledgement");
			break;
		case FUSE_FLUSH:
		case FUSE_FSYNC:
		case FUSE_DESTROY:
			reply(state->fd, input.unique, 0, NULL, 0);
			break;
		case FUSE_FORGET:
		case FUSE_BATCH_FORGET:
			break;
		default:
			reply(state->fd, input.unique, ENOSYS, NULL, 0);
			break;
		}
	}
	free(bytes);
	return NULL;
}

static void expect_errno(int result, int error, const char *message)
{
	CHECK(result == -1 && errno == error, message);
}

int main(void)
{
	CHECK(!mkdir("/dev", 0755) || errno == EEXIST, "device directory");
	CHECK(!mount("devtmpfs", "/dev", "devtmpfs", 0, NULL) || errno == EBUSY, "devtmpfs");
	CHECK(!mkdir("/fusefs", 0755), "FUSE mount directory");
	int source = open("/backing", O_CREAT | O_EXCL | O_RDWR, 0600);
	CHECK(source >= 0 && write(source, "abcdefgh", 8) == 8, "backing contents");
	int device = open("/dev/fuse", O_RDWR | O_CLOEXEC);
	CHECK(device >= 0, "open FUSE device");
	char options[128];
	CHECK(snprintf(options, sizeof(options), "fd=%d,rootmode=40000,user_id=0,group_id=0", device) > 0,
	      "mount options");
	CHECK(!mount("fuse-passthrough", "/fusefs", "fuse", MS_NOSUID | MS_NODEV, options), "FUSE mount");
	struct server state = { .fd = device };
	CHECK(!pipe(state.released), "release completion pipe");
	pthread_t thread;
	CHECK(!pthread_create(&thread, NULL, serve, &state), "server thread");
	/* Do not let a failed INIT read be hidden by the parent's later
	 * ECONNREFUSED lookup. The server must complete its actual reply first. */
	char initialized;
	CHECK(read(state.released[0], &initialized, 1) == 1 && initialized == 'I', "completed FUSE init reply");
	struct stat st;
	CHECK(!stat("/fusefs/file", &st) && S_ISREG(st.st_mode), "initialized file lookup");
	struct fuse_backing_map registration = { .fd = source, .flags = 1 };
	expect_errno(ioctl(device, FUSE_DEV_IOC_BACKING_OPEN, &registration), EINVAL, "unknown registration flags");
	registration.flags = 0;
	registration.fd = -1;
	expect_errno(ioctl(device, FUSE_DEV_IOC_BACKING_OPEN, &registration), EBADF, "invalid backing descriptor");
	registration.fd = source;
	int id = ioctl(device, FUSE_DEV_IOC_BACKING_OPEN, &registration);
	CHECK(id > 0, "backing registration");
	atomic_store(&state.backing, id);
	CHECK(!close(source), "close original backing descriptor");
	puts("fuse-passthrough: negotiation registration errors and owned backing reference pass");
	int file = open("/fusefs/file", O_RDWR);
	CHECK(file >= 0, "open passthrough file");
	char data[8];
	CHECK(pread(file, data, 8, 0) == 8 && !memcmp(data, "abcdefgh", 8), "passthrough read");
	CHECK(pwrite(file, "XYZ", 3, 2) == 3, "passthrough write");
	CHECK(pread(file, data, 8, 0) == 8 && !memcmp(data, "abXYZfgh", 8), "passthrough read after write");
	CHECK(!atomic_load(&state.data_requests), "data bypasses server");
	puts("fuse-passthrough: standard read write bypass server data requests pass");
	CHECK(!ioctl(device, FUSE_DEV_IOC_BACKING_CLOSE, &id), "retire backing registration");
	expect_errno(ioctl(device, FUSE_DEV_IOC_BACKING_CLOSE, &id), ENOENT, "single registration removal");
	CHECK(pread(file, data, 8, 0) == 8 && !memcmp(data, "abXYZfgh", 8), "open file survives registration removal");
	CHECK(!close(file), "close FUSE file");
	/* FUSE RELEASE is asynchronous. Wait for its completed reply, not a
	 * delay or a guessed scheduler window, before attempting unmount. */
	char released;
	CHECK(read(state.released[0], &released, 1) == 1 && released == 'R', "completed FUSE release");
	int verify = open("/backing", O_RDONLY);
	CHECK(verify >= 0 && read(verify, data, 8) == 8 && !memcmp(data, "abXYZfgh", 8), "backing write identity");
	CHECK(!close(verify), "close verification descriptor");
	atomic_store(&state.stopping, 1);
	CHECK(!umount("/fusefs"), "FUSE unmount");
	CHECK(!pthread_join(thread, NULL), "server shutdown");
	CHECK(!atomic_load(&state.data_requests) && atomic_load(&state.releases) == 1, "release and no data fallback");
	CHECK(!close(device) && !close(state.released[0]) && !close(state.released[1]) &&
	      !unlink("/backing") && !rmdir("/fusefs"), "owned resource cleanup");
	puts("fuse-passthrough: retired registration live file release unmount and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
	for (;;) sched_yield();
}
