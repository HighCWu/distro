/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <netpacket/packet.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

enum { PROTOCOL = 0x88b5, HEADER = 14, BODY = 64, FRAME = HEADER + BODY };
_Static_assert(sizeof(struct sockaddr_ll) == 20, "Linux packet address ABI");
static unsigned index_lo;
static void fail(const char *what)
{
	printf("::vm-test::fail: packet sockets: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)
static unsigned char content(unsigned char tag, unsigned i)
{
	return i == 7 ? 0 : (unsigned char)(tag ^ (i * 37));
}
static int64_t milliseconds(void)
{
	struct timespec now;
	CHECK(!clock_gettime(CLOCK_MONOTONIC, &now), "monotonic deadline");
	return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static struct sockaddr_ll address(void)
{
	return (struct sockaddr_ll){.sll_family = AF_PACKET, .sll_protocol = htons(PROTOCOL),
		.sll_ifindex = (int)index_lo, .sll_halen = 6};
}
static int endpoint(int kind, int receiver)
{
	int fd = socket(AF_PACKET, kind | SOCK_NONBLOCK | SOCK_CLOEXEC,
			receiver ? htons(PROTOCOL) : 0);
	CHECK(fd >= 0 && (fcntl(fd, F_GETFL) & O_NONBLOCK) &&
	      (fcntl(fd, F_GETFD) & FD_CLOEXEC), "packet socket and flags");
	if (receiver) {
		struct sockaddr_ll local = address();
		int ignore = 1;
		CHECK(!bind(fd, (struct sockaddr *)&local, sizeof(local)), "bind loopback packet socket");
		CHECK(!setsockopt(fd, SOL_PACKET, PACKET_IGNORE_OUTGOING, &ignore, sizeof(ignore)),
		      "receive only incoming loopback copy");
	}
	return fd;
}
static void receive_frame(int fd, int raw, unsigned char tag, int truncated)
{
	CHECK(!raw || !truncated, "raw receive requires full header storage");
	int64_t end = milliseconds() + 2000;
	for (unsigned attempts = 0; attempts < 32; attempts++) {
		int64_t left = end - milliseconds();
		CHECK(left > 0, "packet receive deadline");
		struct pollfd pollfd = {.fd = fd, .events = POLLIN};
		int ready = poll(&pollfd, 1, (int)left);
		if (ready < 0 && errno == EINTR) continue;
		CHECK(ready == 1 && (pollfd.revents & POLLIN), "packet readiness");
		unsigned char buffer[FRAME + 2];
		memset(buffer, 0xcc, sizeof(buffer));
		size_t size = truncated ? 8 : (raw ? FRAME : BODY);
		size_t first = raw ? HEADER : 4;
		struct iovec vector[] = {{buffer + 1, first}, {buffer + 1 + first, size - first}};
		struct sockaddr_ll peer = {0};
		struct msghdr message = {.msg_name = &peer, .msg_namelen = sizeof(peer),
			.msg_iov = vector, .msg_iovlen = 2};
		ssize_t result = recvmsg(fd, &message, MSG_TRUNC);
		if (result < 0 && (errno == EINTR || errno == EAGAIN)) continue;
		size_t offset = raw ? HEADER : 0;
		CHECK(result >= (ssize_t)(offset + 1), "receive frame payload");
		if (buffer[1 + offset] != tag) continue;
		CHECK(result == (raw ? FRAME : BODY), "raw/cooked full message length");
		CHECK(message.msg_namelen == sizeof(peer) && peer.sll_family == AF_PACKET &&
		      peer.sll_ifindex == (int)index_lo && peer.sll_protocol == htons(PROTOCOL),
		      "packet source address");
		CHECK(peer.sll_pkttype == PACKET_HOST, "incoming copy rather than outgoing tap");
		CHECK(!!(message.msg_flags & MSG_TRUNC) == !!truncated, "packet truncation flag");
		CHECK(buffer[0] == 0xcc && buffer[1 + size] == 0xcc, "receive buffer guards");
		if (raw) CHECK(buffer[13] == 0x88 && buffer[14] == 0xb5, "retained Ethernet protocol");
		for (unsigned i = 0; i < size - offset; i++)
			CHECK(buffer[1 + offset + i] == content(tag, i), "binary packet contents");
		return;
	}
	fail("bounded packet matching");
}
int main(void)
{
	/* Target-only: this program changes its own Linux/Wasm interface flags
	 * and credentials. Host checks must compile/analyze it, never run it. */
	int setup = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	CHECK(setup >= 0, "interface control socket");
	struct ifreq request = {0};
	strcpy(request.ifr_name, "lo");
	CHECK(!ioctl(setup, SIOCGIFFLAGS, &request), "loopback original flags");
	short original = request.ifr_flags;
	request.ifr_flags |= IFF_UP;
	CHECK(!ioctl(setup, SIOCSIFFLAGS, &request), "loopback up");
	index_lo = if_nametoindex("lo");
	CHECK(index_lo != 0, "loopback interface index");
	int raw_receive = endpoint(SOCK_RAW, 1), cooked_receive = endpoint(SOCK_DGRAM, 1);
	int raw_send = endpoint(SOCK_RAW, 0), cooked_send = endpoint(SOCK_DGRAM, 0);
	struct sockaddr_ll destination = address();
	unsigned char frame[FRAME] = {0};
	frame[6] = 2;
	frame[12] = 0x88;
	frame[13] = 0xb5;
	for (unsigned i = 0; i < BODY; i++) frame[HEADER + i] = content(0x31, i);
	CHECK(sendto(raw_send, frame, FRAME, 0, (struct sockaddr *)&destination,
		     sizeof(destination)) == FRAME, "raw loopback transmission");
	receive_frame(raw_receive, 1, 0x31, 0);
	receive_frame(cooked_receive, 0, 0x31, 1);
	puts("packet sockets: raw loopback frames and cooked truncation pass");
	for (unsigned i = 0; i < BODY; i++) frame[HEADER + i] = content(0x52, i);
	CHECK(sendto(cooked_send, frame + HEADER, BODY, 0, (struct sockaddr *)&destination,
		     sizeof(destination)) == BODY, "cooked loopback transmission");
	receive_frame(raw_receive, 1, 0x52, 0);
	receive_frame(cooked_receive, 0, 0x52, 0);
	puts("packet sockets: cooked transmission, addressing and socket flags pass");
	CHECK(!close(raw_receive) && !close(cooked_receive) && !close(raw_send) && !close(cooked_send),
	      "close packet descriptors");
	request.ifr_flags = original;
	CHECK(!ioctl(setup, SIOCSIFFLAGS, &request) && !close(setup), "restore interface and close control");
	CHECK(!setuid(65534), "drop credentials for capability check");
	for (unsigned i = 0; i < 2; i++) {
		errno = 0;
		int fd = socket(AF_PACKET, (i ? SOCK_DGRAM : SOCK_RAW), htons(PROTOCOL));
		CHECK(fd == -1 && errno == EPERM, "unprivileged packet creation refused");
	}
	int ordinary = socket(AF_INET, SOCK_DGRAM, 0);
	CHECK(ordinary >= 0 && !close(ordinary), "ordinary socket remains available");
	puts("packet sockets: interface restoration, capability denial and descriptor cleanup pass");
	return 0;
}
