/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

/* Linux errqueue wire format, local to this test; no libc API is added. */
struct extended_error {
	uint32_t error;
	uint8_t origin, type, code, pad;
	uint32_t info, data;
};
_Static_assert(sizeof(struct extended_error) == 16, "Linux sock_extended_err layout");
enum { payload_size = 16384, copied_completion = 1, zerocopy_origin = 5 };
static unsigned char payload[payload_size], received[payload_size], expected[payload_size];

/* The pinned libc macro compares size_t with a pointer difference. Keep its
 * existing bounds logic; scope only that header diagnostic, not this test. */
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-compare"
static struct cmsghdr *next_cmsg(struct msghdr *msg, struct cmsghdr *c)
{
	return CMSG_NXTHDR(msg, c);
}
#pragma GCC diagnostic pop

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: socket-zerocopy: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

static void ready(int fd, short events)
{
	struct pollfd p = { .fd = fd, .events = events };
	int result;
	do result = poll(&p, 1, 5000); while (result < 0 && errno == EINTR);
	require(result == 1 && (p.revents & events), "socket readiness deadline");
}

static int endpoint(int family, int type)
{
	int fd = socket(family, type | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	int size = 256 * 1024;
	require(fd >= 0 && setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &size, sizeof size) == 0 &&
	        setsockopt(fd, SOL_SOCKET, SO_RCVBUF, &size, sizeof size) == 0, "socket and buffer limits");
	return fd;
}

static void connect_ready(int fd, const struct sockaddr *address, socklen_t length)
{
	int result = connect(fd, address, length);
	require(result == 0 || (result == -1 && errno == EINPROGRESS), "connect start");
	ready(fd, POLLOUT);
	int error = -1;
	socklen_t size = sizeof error;
	require(getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && !error, "connect completion");
}

static void read_payload(int fd, size_t length, int stream)
{
	size_t offset = 0;
	while (offset < length) {
		ready(fd, POLLIN);
		ssize_t n = recv(fd, received + offset, length - offset, 0);
		require(n > 0 && (stream || n == (ssize_t)length), "receive complete payload");
		offset += (size_t)n;
	}
	require(!memcmp(received, expected, length), "binary data integrity after notified buffer reuse");
}

static void completion(int fd, int family, uint32_t sequence)
{
	union { struct cmsghdr alignment; unsigned char bytes[512]; } control;
	unsigned char data[1];
	struct iovec vector = { data, sizeof data };
	struct msghdr msg = { .msg_iov = &vector, .msg_iovlen = 1,
		.msg_control = control.bytes, .msg_controllen = sizeof control.bytes };
	ready(fd, POLLERR);
	require(recvmsg(fd, &msg, MSG_ERRQUEUE | MSG_DONTWAIT) >= 0 && !(msg.msg_flags & MSG_CTRUNC),
	        "receive untruncated completion metadata");
	int found = 0;
	for (struct cmsghdr *c = CMSG_FIRSTHDR(&msg); c; c = next_cmsg(&msg, c)) {
		if (c->cmsg_level != (family == AF_INET ? IPPROTO_IP : IPPROTO_IPV6) ||
		    c->cmsg_type != (family == AF_INET ? IP_RECVERR : IPV6_RECVERR)) continue;
		require(c->cmsg_len >= CMSG_LEN(sizeof(struct extended_error)), "completion structure length");
		struct extended_error error;
		memcpy(&error, CMSG_DATA(c), sizeof error);
		require(!error.error && error.origin == zerocopy_origin && error.code == copied_completion &&
		        error.info == sequence && error.data == sequence, "copied completion and send sequence");
		found++;
	}
	require(found == 1, "one Linux zerocopy completion record");
}

static void exercise(int family, int type)
{
	int receiver = endpoint(family, type), sender = endpoint(family, type), listener = -1;
	struct sockaddr_storage storage = {0};
	socklen_t length;
	if (family == AF_INET) {
		struct sockaddr_in *a = (void *)&storage;
		a->sin_family = AF_INET; a->sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		length = sizeof *a;
	} else {
		struct sockaddr_in6 *a = (void *)&storage;
		a->sin6_family = AF_INET6; a->sin6_addr = in6addr_loopback;
		length = sizeof *a;
	}
	require(bind(receiver, (void *)&storage, length) == 0 &&
	        getsockname(receiver, (void *)&storage, &length) == 0, "loopback bind");
	if (type == SOCK_STREAM) require(listen(receiver, 1) == 0, "listen");
	connect_ready(sender, (void *)&storage, length);
	if (type == SOCK_STREAM) {
		listener = receiver;
		ready(listener, POLLIN);
		receiver = accept4(listener, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
		require(receiver >= 0, "accept");
	}
	int enabled = 1, observed = 0;
	socklen_t size = sizeof observed;
	require(setsockopt(sender, SOL_SOCKET, SO_ZEROCOPY, &enabled, sizeof enabled) == 0 &&
	        getsockopt(sender, SOL_SOCKET, SO_ZEROCOPY, &observed, &size) == 0 && observed == 1,
	        "existing zerocopy socket option");
	for (uint32_t round = 0; round < 2; round++) {
		for (unsigned i = 0; i < sizeof payload; i++) payload[i] = (unsigned char)(i * 37 + round * 13);
		memcpy(expected, payload, sizeof payload);
		struct iovec vectors[] = { { payload, 19 }, { payload + 19, sizeof payload - 19 } };
		struct msghdr msg = { .msg_iov = vectors, .msg_iovlen = 2 };
		require(sendmsg(sender, &msg, MSG_ZEROCOPY | MSG_NOSIGNAL) == sizeof payload, "zerocopy flagged sendmsg");
		completion(sender, family, round);
		/* Reuse before the peer reads, but only AFTER notification. A false
		 * copied completion must not expose an alias into the reused buffer. */
		memset(payload, 0x5a, sizeof payload);
		read_payload(receiver, sizeof payload, type == SOCK_STREAM);
	}
	memcpy(expected, payload, 32);
	require(send(sender, payload, 32, MSG_NOSIGNAL) == 32, "ordinary send after copied completions");
	read_payload(receiver, 32, type == SOCK_STREAM);
	struct msghdr empty = {0};
	require(recvmsg(sender, &empty, MSG_ERRQUEUE | MSG_DONTWAIT) == -1 && errno == EAGAIN,
	        "ordinary send creates no zerocopy notification");
	require(close(sender) == 0 && close(receiver) == 0 && (listener < 0 || close(listener) == 0),
	        "socket descriptor cleanup");
	printf("socket-zerocopy: IPv%d %s bytes, copied completions, reuse and cleanup pass\n",
	       family == AF_INET ? 4 : 6, type == SOCK_STREAM ? "TCP" : "UDP");
}

int main(void)
{
#ifdef __wasm__
	/* Configure only the isolated test machine, never the native build host. */
	int setup = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	struct ifreq request = { .ifr_name = "lo" };
	require(setup >= 0 && ioctl(setup, SIOCGIFFLAGS, &request) == 0, "loopback flags");
	request.ifr_flags |= IFF_UP;
	require(ioctl(setup, SIOCSIFFLAGS, &request) == 0 && close(setup) == 0, "loopback up");
#endif
	exercise(AF_INET, SOCK_STREAM);
	exercise(AF_INET, SOCK_DGRAM);
	exercise(AF_INET6, SOCK_STREAM);
	exercise(AF_INET6, SOCK_DGRAM);
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
