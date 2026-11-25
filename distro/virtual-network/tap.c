/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_ether.h>
#include <linux/if_tun.h>
#include <net/if.h>
#include <net/if_arp.h>
#include <netpacket/packet.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void check(int ok, const char *stage)
{
	if (!ok) {
		fprintf(stderr, "::vm-test::fail: TAP: %s (errno=%d)\n", stage, errno);
		exit(1);
	}
}

static void wait_readable(int fd, const char *stage)
{
	struct pollfd pfd = {.fd = fd, .events = POLLIN};
	check(poll(&pfd, 1, 3000) == 1 && (pfd.revents & POLLIN), stage);
}

static void make_frame(unsigned char frame[ETH_ZLEN], const unsigned char *destination,
		       const unsigned char *source, unsigned char seed)
{
	memcpy(frame, destination, ETH_ALEN);
	memcpy(frame + ETH_ALEN, source, ETH_ALEN);
	frame[12] = (unsigned char)(ETH_P_802_EX1 >> 8);
	frame[13] = (unsigned char)ETH_P_802_EX1;
	for (size_t i = ETH_HLEN; i < ETH_ZLEN; i++)
		frame[i] = (unsigned char)(seed + i);
}

int main(void)
{
	int tap = open("/dev/net/tun", O_RDWR | O_CLOEXEC | O_NONBLOCK);
	check(tap >= 0, "open /dev/net/tun");
	struct ifreq req = {.ifr_name = "wasmtap", .ifr_flags = IFF_TAP | IFF_NO_PI};
	check(ioctl(tap, TUNSETIFF, &req) == 0 && strcmp(req.ifr_name, "wasmtap") == 0,
	      "create TAP without packet information prefix");

	int packet_socket = socket(AF_PACKET, SOCK_RAW | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
	check(packet_socket >= 0, "open raw packet socket");
	check(ioctl(packet_socket, SIOCGIFINDEX, &req) == 0, "read TAP interface index");
	int ifindex = req.ifr_ifindex;
	check(ioctl(packet_socket, SIOCGIFHWADDR, &req) == 0 &&
	      req.ifr_hwaddr.sa_family == ARPHRD_ETHER, "read TAP Ethernet address");
	unsigned char local_mac[ETH_ALEN];
	memcpy(local_mac, req.ifr_hwaddr.sa_data, sizeof(local_mac));
	req.ifr_flags = IFF_UP;
	check(ioctl(packet_socket, SIOCSIFFLAGS, &req) == 0, "bring up TAP");

	struct sockaddr_ll endpoint = {
		.sll_family = AF_PACKET,
		.sll_protocol = htons(ETH_P_802_EX1),
		.sll_ifindex = ifindex,
	};
	check(bind(packet_socket, (const struct sockaddr *)&endpoint, sizeof(endpoint)) == 0,
	      "bind raw socket to TAP and experimental EtherType");

	static const unsigned char peer_mac[ETH_ALEN] = {0x02, 0x0e, 0x12, 0x24, 0x36, 0x48};
	unsigned char incoming[ETH_ZLEN];
	make_frame(incoming, local_mac, peer_mac, 0x89);
	check(write(tap, incoming, sizeof(incoming)) == sizeof(incoming), "inject Ethernet frame");
	wait_readable(packet_socket, "wait for inbound Ethernet frame");
	unsigned char received[2048];
	struct sockaddr_ll peer = {0};
	socklen_t peer_len = sizeof(peer);
	ssize_t bytes = recvfrom(packet_socket, received, sizeof(received), 0,
				 (struct sockaddr *)&peer, &peer_len);
	check(bytes == sizeof(incoming) && memcmp(received, incoming, sizeof(incoming)) == 0 &&
	      peer_len == sizeof(peer) && peer.sll_family == AF_PACKET &&
	      peer.sll_protocol == endpoint.sll_protocol && peer.sll_ifindex == ifindex &&
	      peer.sll_pkttype == PACKET_HOST && peer.sll_halen == ETH_ALEN &&
	      memcmp(peer.sll_addr, peer_mac, sizeof(peer_mac)) == 0,
	      "verify incoming frame bytes and receive direction");

	unsigned char outgoing[ETH_ZLEN];
	make_frame(outgoing, peer_mac, local_mac, 0x32);
	endpoint.sll_halen = ETH_ALEN;
	memcpy(endpoint.sll_addr, peer_mac, sizeof(peer_mac));
	check(sendto(packet_socket, outgoing, sizeof(outgoing), 0,
		     (const struct sockaddr *)&endpoint, sizeof(endpoint)) == sizeof(outgoing),
	      "send outbound Ethernet frame");
	for (int attempt = 0;; attempt++) {
		check(attempt < 8, "find outbound frame by EtherType");
		wait_readable(tap, "wait for outbound Ethernet frame");
		bytes = read(tap, received, sizeof(received));
		check(bytes >= ETH_HLEN, "read outbound Ethernet frame");
		/* TAP may carry unrelated IPv6 link-local traffic while coming up. */
		if (received[12] != outgoing[12] || received[13] != outgoing[13])
			continue;
		check(bytes == sizeof(outgoing) && memcmp(received, outgoing, sizeof(outgoing)) == 0,
		      "verify outgoing frame bytes");
		break;
	}

	check(close(packet_socket) == 0, "close raw packet socket");
	check(close(tap) == 0, "close TAP");
	puts("virtual network: TAP bidirectional Ethernet pass");
	return 0;
}
