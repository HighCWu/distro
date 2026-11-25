/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>
#include <time.h>
#include <unistd.h>

enum { PORT = 4050, IO_TIMEOUT_MS = 30 * 1000, FRAME = 8 };

static const unsigned char requests[2][FRAME] = {
	{0x41, 0, 0x18, 0xff, 0x5a, 0x10, 0x80, 0x33},
	{0x42, 0x01, 0, 0xd2, 0x80, 0x7f, 0x29, 0xfe},
};
static const unsigned char replies[2][FRAME] = {
	{0x61, 0x55, 0, 0x80, 0x31, 0xee, 0x05, 0x9a},
	{0x62, 0, 0x44, 0xda, 0x02, 0x77, 0xa9, 0x01},
};
static const unsigned char acknowledgments[2] = {0xa1, 0xb2};
static const unsigned char final_reply[FRAME] = {0x6a, 0x09, 0xff, 0, 0x33, 0x88, 0x17, 0xde};

static void check(int ok, const char *stage)
{
	if (ok)
		return;
	fprintf(stderr, "::vm-test::fail: vsock: %s (errno=%d)\n", stage, errno);
	exit(1);
}

static int64_t monotonic_ms(void)
{
	struct timespec now;
	check(clock_gettime(CLOCK_MONOTONIC, &now) == 0, "read monotonic clock");
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void wait_ready(int fd, short events, int64_t deadline, const char *stage)
{
	struct pollfd pollfd = {.fd = fd, .events = events};
	for (;;) {
		int64_t remaining = deadline - monotonic_ms();
		if (remaining <= 0) {
			errno = ETIMEDOUT;
			check(0, stage);
		}
		int result = poll(&pollfd, 1, (int)remaining);
		if (result < 0 && errno == EINTR)
			continue;
		if (result == 0)
			errno = ETIMEDOUT;
		// Let connect or recv report the precise error/EOF for these events.
		check(result == 1 && (pollfd.revents & (events | POLLERR | POLLHUP)), stage);
		return;
	}
}

static int connect_stream(int64_t deadline)
{
	int fd = socket(AF_VSOCK, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	check(fd >= 0, "open AF_VSOCK stream socket");
	struct sockaddr_vm address = {
		.svm_family = AF_VSOCK,
		.svm_cid = VMADDR_CID_HOST,
		.svm_port = PORT,
	};
	if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
		check(errno == EINPROGRESS, "connect to host listener");
		wait_ready(fd, POLLOUT, deadline, "wait for connection");
		int error = 0;
		socklen_t size = sizeof(error);
		check(getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 &&
		      size == sizeof(error), "read connection result");
		errno = error;
		check(error == 0, "complete host connection");
	}
	return fd;
}

static void send_all(int fd, const unsigned char *bytes, size_t size, int64_t deadline)
{
	size_t used = 0;
	while (used < size) {
		wait_ready(fd, POLLOUT, deadline, "wait to send frame");
		ssize_t count = send(fd, bytes + used, size - used, MSG_NOSIGNAL);
		if (count < 0 && (errno == EINTR || errno == EAGAIN))
			continue;
		check(count > 0, "send frame to host");
		used += (size_t)count;
	}
}

static void check_reply(int fd, const unsigned char *expected, int64_t deadline)
{
	unsigned char reply[FRAME];
	size_t used = 0;
	while (used < sizeof(reply)) {
		wait_ready(fd, POLLIN, deadline, "wait to receive reply");
		ssize_t count = recv(fd, reply + used, sizeof(reply) - used, 0);
		if (count < 0 && (errno == EINTR || errno == EAGAIN))
			continue;
		check(count > 0, "receive full reply from host");
		used += (size_t)count;
	}
	check(memcmp(reply, expected, sizeof(reply)) == 0, "verify reply on its original stream");
}

int main(void)
{
	int64_t deadline = monotonic_ms() + IO_TIMEOUT_MS;
	int sockets[2];
	sockets[0] = connect_stream(deadline);
	sockets[1] = connect_stream(deadline);
	for (size_t index = 0; index < 2; index++)
		send_all(sockets[index], requests[index], FRAME, deadline);
	for (size_t index = 0; index < 2; index++)
		check_reply(sockets[index], replies[index], deadline);
	for (size_t index = 0; index < 2; index++)
		send_all(sockets[index], &acknowledgments[index], 1, deadline);
	const uint8_t suffix[] = { 0x24, 0x75 };
	send_all(sockets[0], suffix, sizeof(suffix), deadline);

	check(shutdown(sockets[0], SHUT_WR) == 0, "half-close stream 1 for writes");
	check_reply(sockets[0], final_reply, deadline);
	for (size_t index = 0; index < 2; index++)
		check(close(sockets[index]) == 0, "close stream socket");

	puts("vsock Linux: two simultaneous streams exchanged distinct binary frames");
	puts("vsock Linux: received final frame on stream 1 after SHUT_WR");
	puts("::vm-test::pass");
	fflush(stdout);
	for (;;)
		sleep(1);
}
