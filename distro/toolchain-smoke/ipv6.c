/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

_Static_assert(sizeof(struct sockaddr_in6) == 28, "Linux IPv6 address ABI");
_Static_assert(sizeof(struct in6_pktinfo) == 20, "Linux IPv6 packet info ABI");

static void require(int ok, const char *what)
{
	if (ok) return;
	printf("::vm-test::fail: ipv6: %s errno=%d\n", what, errno);
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#else
	exit(1);
#endif
}

static void ready(int fd, short events)
{
	struct pollfd p = {.fd = fd, .events = events};
	require(poll(&p, 1, 2000) == 1 && (p.revents & events), "socket readiness deadline");
}

static int endpoint(int type)
{
	int fd = socket(AF_INET6, type | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
	require(fd >= 0 && (fcntl(fd, F_GETFD) & FD_CLOEXEC) &&
	        (fcntl(fd, F_GETFL) & O_NONBLOCK), "IPv6 socket and flags");
	return fd;
}

static void connect_ready(int fd, const struct sockaddr *address, socklen_t length)
{
	int result = connect(fd, address, length);
	require(result == 0 || (result == -1 && errno == EINPROGRESS), "connect start");
	ready(fd, POLLOUT);
	int error = -1;
	socklen_t size = sizeof(error);
	require(getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &size) == 0 && error == 0 &&
	        size == sizeof(error), "connect completion");
}

static void tcp(int dual)
{
	int listener = endpoint(SOCK_STREAM);
	int only = !dual, actual = -1;
	socklen_t size = sizeof(actual);
	require(setsockopt(listener, IPPROTO_IPV6, IPV6_V6ONLY, &only, sizeof(only)) == 0 &&
	        getsockopt(listener, IPPROTO_IPV6, IPV6_V6ONLY, &actual, &size) == 0 &&
	        actual == only, "V6ONLY selection");
	struct sockaddr_in6 address = {.sin6_family = AF_INET6, .sin6_addr = IN6ADDR_LOOPBACK_INIT};
	if (dual) address.sin6_addr = in6addr_any;
	require(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0 &&
	        listen(listener, 1) == 0, "TCP bind/listen");
	size = sizeof(address);
	require(getsockname(listener, (struct sockaddr *)&address, &size) == 0 &&
	        size == sizeof(address) && address.sin6_port != 0, "TCP bound address");
	int client;
	if (dual) {
		client = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
		require(client >= 0, "IPv4 client");
		struct sockaddr_in ipv4 = {.sin_family = AF_INET, .sin_port = address.sin6_port,
			.sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
		connect_ready(client, (struct sockaddr *)&ipv4, sizeof(ipv4));
	} else {
		client = endpoint(SOCK_STREAM);
		connect_ready(client, (struct sockaddr *)&address, sizeof(address));
	}
	ready(listener, POLLIN);
	struct sockaddr_in6 peer;
	size = sizeof(peer);
	int accepted = accept4(listener, (struct sockaddr *)&peer, &size, SOCK_NONBLOCK | SOCK_CLOEXEC);
	require(accepted >= 0 && size == sizeof(peer) && peer.sin6_family == AF_INET6 &&
	        (dual ? IN6_IS_ADDR_V4MAPPED(&peer.sin6_addr) : IN6_IS_ADDR_LOOPBACK(&peer.sin6_addr)),
	        "accepted peer family and address");
	const char payload[] = "IPv6\0binary";
	require(send(client, payload, sizeof(payload), MSG_NOSIGNAL) == sizeof(payload), "TCP send");
	ready(accepted, POLLIN);
	char bytes[sizeof(payload)];
	size_t received = 0;
	while (received < sizeof(bytes)) {
		ready(accepted, POLLIN);
		ssize_t n = recv(accepted, bytes + received, sizeof(bytes) - received, 0);
		require(n > 0, "TCP receive");
		received += (size_t)n;
	}
	require(memcmp(bytes, payload, sizeof(bytes)) == 0 && shutdown(client, SHUT_WR) == 0, "TCP bytes and shutdown");
	ready(accepted, POLLIN);
	require(recv(accepted, bytes, sizeof(bytes), 0) == 0, "TCP orderly EOF");
	require(close(accepted) == 0 && close(client) == 0 && close(listener) == 0, "TCP cleanup");
	puts(dual ? "ipv6: dual-stack listener accepts IPv4-mapped peer, bytes and EOF pass" :
	     "ipv6: loopback TCP connect, accept, binary bytes and EOF pass");
}

static void udp(void)
{
	int receiver = endpoint(SOCK_DGRAM), sender = endpoint(SOCK_DGRAM), enabled = 1;
	require(setsockopt(receiver, IPPROTO_IPV6, IPV6_RECVPKTINFO, &enabled, sizeof(enabled)) == 0,
	        "receive packet info");
	struct sockaddr_in6 destination = {.sin6_family = AF_INET6, .sin6_addr = IN6ADDR_LOOPBACK_INIT};
	require(bind(receiver, (struct sockaddr *)&destination, sizeof(destination)) == 0, "UDP bind");
	socklen_t length = sizeof(destination);
	require(getsockname(receiver, (struct sockaddr *)&destination, &length) == 0 &&
	        length == sizeof(destination) && destination.sin6_port != 0, "UDP address");
	char first[] = "datagram", second[] = "\0tail";
	struct iovec outgoing[] = {{first, sizeof(first) - 1}, {second, sizeof(second)}};
	struct msghdr message = {.msg_name = &destination, .msg_namelen = sizeof(destination),
		.msg_iov = outgoing, .msg_iovlen = 2};
	const size_t expected = sizeof(first) - 1 + sizeof(second);
	require(sendmsg(sender, &message, 0) == (ssize_t)expected, "UDP sendmsg iovecs");
	ready(receiver, POLLIN);
	char bytes[64];
	union {struct cmsghdr align; char bytes[CMSG_SPACE(sizeof(struct in6_pktinfo))];} control;
	struct iovec incoming = {bytes, sizeof(bytes)};
	struct sockaddr_in6 peer;
	message = (struct msghdr){.msg_name = &peer, .msg_namelen = sizeof(peer), .msg_iov = &incoming,
		.msg_iovlen = 1, .msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
	require(recvmsg(receiver, &message, 0) == (ssize_t)expected &&
	        !(message.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) && message.msg_namelen == sizeof(peer) &&
	        peer.sin6_family == AF_INET6 && IN6_IS_ADDR_LOOPBACK(&peer.sin6_addr) &&
	        !memcmp(bytes, first, sizeof(first) - 1) &&
	        !memcmp(bytes + sizeof(first) - 1, second, sizeof(second)), "UDP payload and source");
	struct cmsghdr *header = CMSG_FIRSTHDR(&message);
	require(header && header->cmsg_level == IPPROTO_IPV6 && header->cmsg_type == IPV6_PKTINFO &&
	        header->cmsg_len == CMSG_LEN(sizeof(struct in6_pktinfo)), "ancillary header ABI");
	struct in6_pktinfo info;
	memcpy(&info, CMSG_DATA(header), sizeof(info));
	require(IN6_IS_ADDR_LOOPBACK(&info.ipi6_addr) && info.ipi6_ifindex == if_nametoindex("lo") &&
	        info.ipi6_ifindex != 0, "packet info loopback and interface");
	require(recv(receiver, bytes, sizeof(bytes), 0) == -1 && errno == EAGAIN, "UDP drained queue");
	require(close(receiver) == 0 && close(sender) == 0, "UDP cleanup");
	puts("ipv6: UDP scatter-gather payload, source and packet-info ancillary ABI pass");
}

int main(void)
{
#ifdef __wasm__
	/* A raw initramfs has no userspace network setup; do not change host networking. */
	int setup = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	struct ifreq request = {.ifr_name = "lo"};
	require(setup >= 0 && ioctl(setup, SIOCGIFFLAGS, &request) == 0, "loopback flags");
	request.ifr_flags |= IFF_UP;
	require(ioctl(setup, SIOCSIFFLAGS, &request) == 0 && close(setup) == 0, "loopback up");
#endif
	tcp(0);
	tcp(1);
	udp();
	puts("::vm-test::pass");
	fflush(stdout);
#ifdef __wasm__
	for (;;) sched_yield();
#endif
	return 0;
}
