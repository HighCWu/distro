// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <linux/netlink.h>
#include <linux/packet_diag.h>
#include <linux/sock_diag.h>
#include <net/if.h>
#include <netinet/in.h>
#include <netinet/ip.h>
#include <netinet/udp.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "packet-socket-runtime: %s (errno=%d: %s)\n", what,
		errno, strerror(errno));
	exit(1);
}

static uint64_t socket_inode(int fd)
{
	struct stat st;
	require(fstat(fd, &st) == 0 && S_ISSOCK(st.st_mode) && st.st_ino > 0,
		"fstat socket inode");
	return (uint64_t)st.st_ino;
}

static void verify_packet_diag(uint64_t pkt_ino)
{
	int diag_fd =
		socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
	require(diag_fd >= 0, "socket NETLINK_SOCK_DIAG");

	struct sockaddr_nl local = { .nl_family = AF_NETLINK };
	require(bind(diag_fd, (const struct sockaddr *)&local, sizeof(local)) ==
			0,
		"bind NETLINK_SOCK_DIAG");

	struct {
		struct nlmsghdr nlh;
		struct packet_diag_req req;
	} query;
	memset(&query, 0, sizeof(query));
	query.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(query.req));
	query.nlh.nlmsg_type = SOCK_DIAG_BY_FAMILY;
	query.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
	query.nlh.nlmsg_seq = 1;
	query.req.sdiag_family = AF_PACKET;
	query.req.sdiag_protocol = 0;
	query.req.pdiag_show = PACKET_SHOW_INFO;

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(diag_fd, &query, query.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)query.nlh.nlmsg_len, "send packet_diag_req");

	int saw_pkt = 0;
	for (;;) {
		char buf[8192];
		ssize_t n = recv(diag_fd, buf, sizeof(buf), 0);
		require(n > 0, "recv packet_diag dump");
		for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
		     NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
			if (nlh->nlmsg_type == NLMSG_DONE) {
				require(saw_pkt,
					"PACKET_DIAG dump includes AF_PACKET socket");
				require(close(diag_fd) == 0, "close diag_fd");
				return;
			}
			require(nlh->nlmsg_type == SOCK_DIAG_BY_FAMILY,
				"packet_diag message type");
			const struct packet_diag_msg *msg =
				(const struct packet_diag_msg *)NLMSG_DATA(nlh);
			require(msg->pdiag_family == AF_PACKET,
				"packet_diag family matches");
			if (msg->pdiag_ino == pkt_ino) {
				require(msg->pdiag_type == SOCK_DGRAM,
					"packet_diag type is SOCK_DGRAM");
				require(msg->pdiag_num == ETH_P_IP,
					"packet_diag protocol is ETH_P_IP");
				saw_pkt = 1;
			}
		}
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	uint32_t lo_ifindex = if_nametoindex("lo");
	require(lo_ifindex > 0, "if_nametoindex(lo)");

	int pkt_fd = socket(AF_PACKET, SOCK_DGRAM | SOCK_CLOEXEC,
			    htons(ETH_P_IP));
	require(pkt_fd >= 0, "socket(AF_PACKET, SOCK_DGRAM, ETH_P_IP)");

	int ver = TPACKET_V2;
	require(setsockopt(pkt_fd, SOL_PACKET, PACKET_VERSION, &ver,
			   sizeof(ver)) == 0,
		"setsockopt PACKET_VERSION TPACKET_V2");
	int got_ver = 0;
	socklen_t vlen = sizeof(got_ver);
	require(getsockopt(pkt_fd, SOL_PACKET, PACKET_VERSION, &got_ver,
			   &vlen) == 0 &&
			got_ver == TPACKET_V2,
		"getsockopt PACKET_VERSION == TPACKET_V2");

	/* Invalid interface index must fail cleanly with ENODEV. */
	struct sockaddr_ll bad_addr;
	memset(&bad_addr, 0, sizeof(bad_addr));
	bad_addr.sll_family = AF_PACKET;
	bad_addr.sll_protocol = htons(ETH_P_IP);
	bad_addr.sll_ifindex = 0x7fffffff;
	errno = 0;
	require(bind(pkt_fd, (const struct sockaddr *)&bad_addr,
		     sizeof(bad_addr)) == -1 &&
			errno == ENODEV,
		"bind AF_PACKET invalid ifindex returns ENODEV");

	struct sockaddr_ll sll;
	memset(&sll, 0, sizeof(sll));
	sll.sll_family = AF_PACKET;
	sll.sll_protocol = htons(ETH_P_IP);
	sll.sll_ifindex = (int)lo_ifindex;
	require(bind(pkt_fd, (const struct sockaddr *)&sll, sizeof(sll)) == 0,
		"bind AF_PACKET to lo");

	/* Setup UDP loopback pair to generate real IPv4/UDP traffic on lo. */
	int udp_rx = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	require(udp_rx >= 0, "socket UDP rx");
	struct sockaddr_in dst = { .sin_family = AF_INET,
				   .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
	require(bind(udp_rx, (const struct sockaddr *)&dst, sizeof(dst)) == 0,
		"bind UDP rx");
	socklen_t dlen = sizeof(dst);
	require(getsockname(udp_rx, (struct sockaddr *)&dst, &dlen) == 0 &&
			dst.sin_port != 0,
		"getsockname UDP rx");

	int udp_tx = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	require(udp_tx >= 0, "socket UDP tx");
	const char *payload = "packet-socket-diag-v1";
	size_t payload_len = strlen(payload);
	require(sendto(udp_tx, payload, payload_len, 0,
		       (const struct sockaddr *)&dst, sizeof(dst)) ==
			(ssize_t)payload_len,
		"sendto UDP loopback");

	int captured = 0;
	for (int round = 0; round < 16 && !captured; round++) {
		struct pollfd pfd = { .fd = pkt_fd, .events = POLLIN };
		int prc = poll(&pfd, 1, 2000);
		require(prc > 0 && (pfd.revents & POLLIN), "poll AF_PACKET");

		uint8_t frame[2048];
		struct sockaddr_ll from;
		socklen_t flen = sizeof(from);
		ssize_t fn = recvfrom(pkt_fd, frame, sizeof(frame), 0,
				      (struct sockaddr *)&from, &flen);
		require(fn > 0, "recvfrom AF_PACKET");
		if ((size_t)fn < sizeof(struct iphdr)) continue;

		const struct iphdr *ip = (const struct iphdr *)frame;
		size_t ihl = (size_t)ip->ihl * 4u;
		if (ip->protocol != IPPROTO_UDP ||
		    (size_t)fn < ihl + sizeof(struct udphdr) + payload_len) {
			continue;
		}
		const struct udphdr *udp =
			(const struct udphdr *)(frame + ihl);
		if (udp->dest != dst.sin_port) continue;

		const char *udp_data =
			(const char *)(frame + ihl + sizeof(struct udphdr));
		require(memcmp(udp_data, payload, payload_len) == 0,
			"AF_PACKET captured exact UDP payload");
		captured = 1;
	}
	require(captured, "captured loopback UDP packet via AF_PACKET");

	struct tpacket_stats stats;
	socklen_t slen = sizeof(stats);
	require(getsockopt(pkt_fd, SOL_PACKET, PACKET_STATISTICS, &stats,
			   &slen) == 0,
		"getsockopt PACKET_STATISTICS");
	require(stats.tp_packets >= 1 && stats.tp_drops == 0,
		"PACKET_STATISTICS shows >= 1 packet and 0 drops");

	char rx_buf[64] = { 0 };
	require(recv(udp_rx, rx_buf, sizeof(rx_buf) - 1, 0) ==
				(ssize_t)payload_len &&
			strcmp(rx_buf, payload) == 0,
		"UDP rx received matching payload");

	verify_packet_diag(socket_inode(pkt_fd));

	require(close(udp_tx) == 0 && close(udp_rx) == 0, "close UDP sockets");
	require(close(pkt_fd) == 0, "close AF_PACKET socket");

	puts("packet socket runtime: AF_PACKET capture, stats, TPACKET_V2 and PACKET_DIAG pass");
	return 0;
}
