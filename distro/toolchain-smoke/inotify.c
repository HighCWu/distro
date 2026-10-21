/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/inotify.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>

_Static_assert(sizeof(struct inotify_event) == 16, "Linux inotify record header");
#ifdef __wasm__
_Static_assert(sizeof(struct epoll_event) == 16 &&
               __builtin_offsetof(struct epoll_event, data) == 8, "Wasm generic epoll layout");
#endif

static void require(int ok, const char *what) {
	if (!ok) {
		printf("::vm-test::fail: inotify: %s errno=%d\n", what, errno);
		fflush(stdout);
#ifdef __wasm__
		for (;;) sched_yield();
#else
		exit(1);
#endif
	}
}

int main(void) {
	if (mkdir("/tmp", 0700)) require(errno == EEXIST, "temporary directory");
	char path[] = "/tmp/inotify-XXXXXX";
	require(mkdtemp(path) != NULL, "mkdtemp");
	int dir = open(path, O_RDONLY | O_DIRECTORY);
	int fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC);
	require(dir >= 0 && fd >= 0, "init1");
	require((fcntl(fd, F_GETFD) & FD_CLOEXEC) &&
	        (fcntl(fd, F_GETFL) & O_NONBLOCK), "descriptor flags");
	require(inotify_init1(-1) == -1 && errno == EINVAL, "invalid init flags");
	int wd = inotify_add_watch(fd, path, IN_CREATE | IN_MODIFY | IN_CLOSE_WRITE |
	                          IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE);
	require(wd >= 0, "add watch");
	int ep = epoll_create1(EPOLL_CLOEXEC);
	struct epoll_event interest = {.events = EPOLLIN, .data.u64 = UINT64_C(0x123456789abcdef0)};
	require(ep >= 0 && epoll_ctl(ep, EPOLL_CTL_ADD, fd, &interest) == 0, "epoll add");
	struct epoll_event ready;
	require(epoll_wait(ep, &ready, 1, 0) == 0, "empty readiness");
	char buffer[4096];
	require(read(fd, buffer, sizeof(buffer)) == -1 && errno == EAGAIN, "empty nonblocking read");
	int file = openat(dir, "before", O_CREAT | O_WRONLY | O_EXCL, 0600);
	require(file >= 0 && write(file, "data", 4) == 4 && close(file) == 0, "file write");
	require(renameat(dir, "before", dir, "after") == 0 &&
	        unlinkat(dir, "after", 0) == 0, "rename and delete");
	require(epoll_wait(ep, &ready, 1, 1000) == 1 && (ready.events & EPOLLIN) &&
	        ready.data.u64 == interest.data.u64, "event readiness and data ABI");
	int available = 0, retained = 0;
	require(ioctl(fd, FIONREAD, &available) == 0 && available > 0, "queued size");
	require(read(fd, buffer, 1) == -1 && errno == EINVAL &&
	        ioctl(fd, FIONREAD, &retained) == 0 && retained == available, "short read retains event");
	puts("inotify: descriptor flags, epoll readiness and short-read retention pass");
	ssize_t count = read(fd, buffer, sizeof(buffer));
	require(count == available, "read complete queue");
	uint32_t seen = 0, from = 0, to = 0;
	for (size_t offset = 0; offset < (size_t)count;) {
		struct inotify_event event;
		require((size_t)count - offset >= sizeof(event), "event header bounds");
		memcpy(&event, buffer + offset, sizeof(event));
		require(event.wd == wd && event.len > 0 &&
		        event.len <= (size_t)count - offset - sizeof(event), "event name bounds");
		const char *name = buffer + offset + sizeof(event);
		require(memchr(name, 0, event.len) != NULL, "terminated event name");
		if (event.mask & (IN_CREATE | IN_MODIFY | IN_CLOSE_WRITE | IN_MOVED_FROM))
			require(strcmp(name, "before") == 0, "original name");
		if (event.mask & (IN_MOVED_TO | IN_DELETE))
			require(strcmp(name, "after") == 0, "destination name");
		if (event.mask & IN_MOVED_FROM) from = event.cookie;
		if (event.mask & IN_MOVED_TO) to = event.cookie;
		seen |= event.mask;
		offset += sizeof(event) + event.len;
	}
	uint32_t expected = IN_CREATE | IN_MODIFY | IN_CLOSE_WRITE | IN_MOVED_FROM | IN_MOVED_TO | IN_DELETE;
	require((seen & expected) == expected && from != 0 && from == to, "event masks and rename cookie");
	require(read(fd, buffer, sizeof(buffer)) == -1 && errno == EAGAIN &&
	        epoll_wait(ep, &ready, 1, 0) == 0, "drained readiness");
	puts("inotify: create, modify, close, rename cookies and delete pass");
	require(inotify_rm_watch(fd, wd) == 0, "remove watch");
	count = read(fd, buffer, sizeof(buffer));
	struct inotify_event ignored;
	require(count == sizeof(ignored), "ignored event size");
	memcpy(&ignored, buffer, sizeof(ignored));
	require(ignored.wd == wd && ignored.mask == IN_IGNORED && ignored.len == 0, "ignored event");
	require(inotify_rm_watch(fd, wd) == -1 && errno == EINVAL, "already removed watch");
	require(inotify_add_watch(fd, path, IN_CREATE) >= 0, "watch recovery");
	require(close(ep) == 0 && close(fd) == 0 && close(dir) == 0 && rmdir(path) == 0, "cleanup");
	puts("inotify: explicit removal, ignored event, recovery and cleanup pass");
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
