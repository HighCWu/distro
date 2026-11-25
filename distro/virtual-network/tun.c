/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_tun.h>
#include <net/if.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void check(int ok, const char *stage)
{
	if (!ok) {
		fprintf(stderr, "::vm-test::fail: TUN: %s (errno=%d)\n", stage, errno);
		exit(1);
	}
}

static struct sockaddr_in ipv4(const char *address, unsigned short port)
{
	struct sockaddr_in result = {.sin_family = AF_INET, .sin_port = htons(port)};
	check(inet_pton(AF_INET, address, &result.sin_addr) == 1, "parse IPv4 address");
	return result;
}

static void set_address(int fd, unsigned long command, const char *address)
{
	struct ifreq req = {.ifr_name = "wasmtun"};
	struct sockaddr_in value = ipv4(address, 0);
	memcpy(&req.ifr_addr, &value, sizeof(value));
	check(ioctl(fd, command, &req) == 0, "configure TUN address or netmask");
}

static void wait_readable(int fd, const char *stage)
{
	struct pollfd pfd = {.fd = fd, .events = POLLIN};
	check(poll(&pfd, 1, 3000) == 1 && (pfd.revents & POLLIN), stage);
}

static uint16_t ipv4_checksum(const unsigned char *header)
{
	unsigned sum = 0;
	for (int i = 0; i < 20; i += 2)
		sum += (unsigned)header[i] * 256 + header[i + 1];
	while (sum >> 16)
		sum = (sum & 0xffff) + (sum >> 16);
	return (uint16_t)~sum;
}

int main(void)
{
	int tun = open("/dev/net/tun", O_RDWR | O_CLOEXEC);
	check(tun >= 0, "open /dev/net/tun");
	struct ifreq req = {.ifr_name = "wasmtun", .ifr_flags = IFF_TUN | IFF_NO_PI};
	check(ioctl(tun, TUNSETIFF, &req) == 0, "TUNSETIFF");
	check(strcmp(req.ifr_name, "wasmtun") == 0, "returned interface name");

	int udp = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	check(udp >= 0, "open UDP socket");
	set_address(udp, SIOCSIFADDR, "192.0.2.1");
	set_address(udp, SIOCSIFNETMASK, "255.255.255.0");
	req.ifr_flags = IFF_UP;
	check(ioctl(udp, SIOCSIFFLAGS, &req) == 0, "bring up TUN");
	struct sockaddr_in local = ipv4("192.0.2.1", 17001);
	struct sockaddr_in remote = ipv4("192.0.2.2", 17002);
	check(bind(udp, (struct sockaddr *)&local, sizeof(local)) == 0, "bind local UDP socket");

	static const unsigned char outgoing[] = {0x4c, 0, 0xa1, 0x55};
	check(sendto(udp, outgoing, sizeof(outgoing), 0, (struct sockaddr *)&remote,
		     sizeof(remote)) == sizeof(outgoing), "send UDP to TUN");
	unsigned char packet[2048];
	for (int attempt = 0;; attempt++) {
		check(attempt < 8, "find outbound IPv4 packet");
		wait_readable(tun, "wait for outbound TUN packet");
		ssize_t count = read(tun, packet, sizeof(packet));
		check(count > 0, "read outbound TUN packet");
		if ((packet[0] >> 4) != 4)
			continue; /* The interface may also generate IPv6 link-local traffic. */
		check(count == 28 + sizeof(outgoing) && packet[0] == 0x45 && packet[9] == 17 &&
		      memcmp(packet + 12, &local.sin_addr, 4) == 0 &&
		      memcmp(packet + 16, &remote.sin_addr, 4) == 0 &&
		      memcmp(packet + 20, &local.sin_port, 2) == 0 &&
		      memcmp(packet + 22, &remote.sin_port, 2) == 0 &&
		      memcmp(packet + 28, outgoing, sizeof(outgoing)) == 0, "outbound IPv4 UDP bytes");
		break;
	}

	static const unsigned char incoming[] = {0x92, 0xd3, 0, 0x5a};
	unsigned char reply[28 + sizeof(incoming)] = {
		[0] = 0x45, [3] = sizeof(reply), [8] = 64, [9] = 17, [25] = 8 + sizeof(incoming),
	};
	memcpy(reply + 12, &remote.sin_addr, 4);
	memcpy(reply + 16, &local.sin_addr, 4);
	memcpy(reply + 20, &remote.sin_port, 2);
	memcpy(reply + 22, &local.sin_port, 2);
	memcpy(reply + 28, incoming, sizeof(incoming));
	uint16_t checksum = htons(ipv4_checksum(reply));
	memcpy(reply + 10, &checksum, sizeof(checksum));
	check(write(tun, reply, sizeof(reply)) == sizeof(reply), "inject inbound TUN packet");
	wait_readable(udp, "wait for injected UDP packet");
	struct sockaddr_in peer = {0};
	socklen_t peer_len = sizeof(peer);
	check(recvfrom(udp, packet, sizeof(packet), 0, (struct sockaddr *)&peer, &peer_len) ==
	      sizeof(incoming) && peer_len == sizeof(peer) && peer.sin_family == AF_INET &&
	      peer.sin_addr.s_addr == remote.sin_addr.s_addr && peer.sin_port == remote.sin_port &&
	      memcmp(packet, incoming, sizeof(incoming)) == 0, "inbound UDP bytes and peer");
	check(close(udp) == 0 && close(tun) == 0, "close endpoints");
	puts("virtual network: TUN bidirectional IPv4 UDP pass");
	return 0;
}
