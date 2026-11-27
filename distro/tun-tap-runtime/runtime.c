// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/if.h>
#include <linux/if_tun.h>
#include <linux/ip.h>
#include <linux/sockios.h>
#include <linux/udp.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "tun-tap-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static uint16_t checksum_finish(uint32_t sum)
{
	while (sum >> 16) {
		sum = (sum & 0xffffu) + (sum >> 16);
	}
	return (uint16_t)(~sum & 0xffffu);
}

static uint32_t checksum_add(uint32_t sum, const void *buf, size_t len)
{
	const uint8_t *p = (const uint8_t *)buf;
	for (size_t i = 0; i + 1 < len; i += 2) {
		sum += ((uint32_t)p[i] << 8) | (uint32_t)p[i + 1];
	}
	if (len & 1u) {
		sum += (uint32_t)p[len - 1] << 8;
	}
	return sum;
}

static void set_ipv4_ioctl(int ctrl_fd, const char *ifname, unsigned long req,
			   const char *ip_str)
{
	struct ifreq ifr;
	memset(&ifr, 0, sizeof(ifr));
	snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
	struct sockaddr_in sin;
	memset(&sin, 0, sizeof(sin));
	sin.sin_family = AF_INET;
	require(inet_pton(AF_INET, ip_str, &sin.sin_addr) == 1, "inet_pton");
	memcpy(&ifr.ifr_addr, &sin, sizeof(sin));
	require(ioctl(ctrl_fd, req, &ifr) == 0, "ioctl ipv4 addr/mask");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	int tun_fd = open("/dev/net/tun", O_RDWR | O_CLOEXEC);
	require(tun_fd >= 0, "open /dev/net/tun for IFF_TUN");

	struct ifreq tun_ifr;
	memset(&tun_ifr, 0, sizeof(tun_ifr));
	snprintf(tun_ifr.ifr_name, sizeof(tun_ifr.ifr_name), "tuntest0");
	tun_ifr.ifr_flags = IFF_TUN | IFF_NO_PI;
	require(ioctl(tun_fd, TUNSETIFF, &tun_ifr) == 0, "TUNSETIFF IFF_TUN");

	int ctrl_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	require(ctrl_fd >= 0, "socket AF_INET ctrl");

	set_ipv4_ioctl(ctrl_fd, tun_ifr.ifr_name, SIOCSIFADDR, "10.77.0.1");
	set_ipv4_ioctl(ctrl_fd, tun_ifr.ifr_name, SIOCSIFNETMASK,
		       "255.255.255.0");
	require(ioctl(ctrl_fd, SIOCGIFFLAGS, &tun_ifr) == 0,
		"SIOCGIFFLAGS tun");
	tun_ifr.ifr_flags |= IFF_UP | IFF_RUNNING;
	require(ioctl(ctrl_fd, SIOCSIFFLAGS, &tun_ifr) == 0,
		"SIOCSIFFLAGS tun IFF_UP");

	int udp_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
	require(udp_fd >= 0, "socket UDP listener");
	struct sockaddr_in local_addr;
	memset(&local_addr, 0, sizeof(local_addr));
	local_addr.sin_family = AF_INET;
	require(inet_pton(AF_INET, "10.77.0.1", &local_addr.sin_addr) == 1,
		"inet_pton 10.77.0.1");
	require(bind(udp_fd, (const struct sockaddr *)&local_addr,
		     sizeof(local_addr)) == 0,
		"bind UDP 10.77.0.1:0");
	socklen_t alen = sizeof(local_addr);
	require(getsockname(udp_fd, (struct sockaddr *)&local_addr, &alen) ==
				0 &&
			local_addr.sin_port != 0,
		"getsockname UDP port");

	/* Inject L3 IPv4+UDP packet 10.77.0.2:44444 -> 10.77.0.1:<local_port>. */
	const char *in_payload = "tun-inbound-v1";
	size_t in_len = strlen(in_payload);
	uint16_t peer_port_be = htons(44444);
	uint32_t saddr_be = 0;
	uint32_t daddr_be = local_addr.sin_addr.s_addr;
	require(inet_pton(AF_INET, "10.77.0.2", &saddr_be) == 1,
		"inet_pton 10.77.0.2");

	uint8_t pkt[256];
	memset(pkt, 0, sizeof(pkt));
	struct iphdr *ip = (struct iphdr *)pkt;
	struct udphdr *udp = (struct udphdr *)(pkt + sizeof(*ip));
	uint8_t *data = pkt + sizeof(*ip) + sizeof(*udp);
	size_t udp_len = sizeof(*udp) + in_len;
	size_t total_len = sizeof(*ip) + udp_len;

	ip->version = 4;
	ip->ihl = 5;
	ip->ttl = 64;
	ip->protocol = IPPROTO_UDP;
	ip->tot_len = htons((uint16_t)total_len);
	ip->saddr = saddr_be;
	ip->daddr = daddr_be;
	ip->check = htons(checksum_finish(checksum_add(0, ip, sizeof(*ip))));

	udp->source = peer_port_be;
	udp->dest = local_addr.sin_port;
	udp->len = htons((uint16_t)udp_len);
	memcpy(data, in_payload, in_len);

	uint32_t psum = 0;
	psum = checksum_add(psum, &ip->saddr, 4);
	psum = checksum_add(psum, &ip->daddr, 4);
	uint16_t proto_len[2] = { htons(IPPROTO_UDP), udp->len };
	psum = checksum_add(psum, proto_len, sizeof(proto_len));
	psum = checksum_add(psum, udp, udp_len);
	uint16_t uck = checksum_finish(psum);
	udp->check = htons(uck ? uck : 0xffffu);

	require(write(tun_fd, pkt, total_len) == (ssize_t)total_len,
		"write inbound IPv4/UDP packet to tun_fd");

	struct pollfd upfd = { .fd = udp_fd, .events = POLLIN };
	require(poll(&upfd, 1, 2000) > 0 && (upfd.revents & POLLIN),
		"poll udp_fd POLLIN");

	char rx[64] = { 0 };
	struct sockaddr_in from;
	socklen_t flen = sizeof(from);
	ssize_t rn = recvfrom(udp_fd, rx, sizeof(rx) - 1, 0,
			      (struct sockaddr *)&from, &flen);
	require(rn == (ssize_t)in_len && strcmp(rx, in_payload) == 0,
		"UDP socket received exact inbound payload");
	require(from.sin_addr.s_addr == saddr_be &&
			from.sin_port == peer_port_be,
		"UDP recvfrom peer addr/port matches");

	/* Send outbound UDP packet 10.77.0.1 -> 10.77.0.2:44444 and read on tun_fd. */
	const char *out_payload = "tun-outbound-v1";
	size_t out_len = strlen(out_payload);
	require(sendto(udp_fd, out_payload, out_len, 0,
		       (const struct sockaddr *)&from, sizeof(from)) ==
			(ssize_t)out_len,
		"sendto outbound UDP reply");

	int saw_outbound = 0;
	for (int round = 0; round < 32 && !saw_outbound; round++) {
		struct pollfd tpfd = { .fd = tun_fd, .events = POLLIN };
		require(poll(&tpfd, 1, 2000) > 0 && (tpfd.revents & POLLIN),
			"poll tun_fd POLLIN");

		uint8_t rbuf[2048];
		ssize_t tn = read(tun_fd, rbuf, sizeof(rbuf));
		require(tn > 0, "read packet from tun_fd");
		if ((size_t)tn < sizeof(struct iphdr)) continue;

		const struct iphdr *rip = (const struct iphdr *)rbuf;
		if (rip->version != 4 || rip->protocol != IPPROTO_UDP) continue;
		size_t ihl = (size_t)rip->ihl * 4u;
		if ((size_t)tn < ihl + sizeof(struct udphdr) + out_len) {
			continue;
		}
		if (rip->saddr != daddr_be || rip->daddr != saddr_be) continue;

		const struct udphdr *rudp =
			(const struct udphdr *)(rbuf + ihl);
		if (rudp->source != local_addr.sin_port ||
		    rudp->dest != peer_port_be) {
			continue;
		}
		const char *rdata =
			(const char *)(rbuf + ihl + sizeof(struct udphdr));
		require(memcmp(rdata, out_payload, out_len) == 0,
			"tun_fd captured exact outbound UDP payload");
		saw_outbound = 1;
	}
	require(saw_outbound, "observed outbound IPv4/UDP packet on tun_fd");

	/* Open second fd as IFF_TAP | IFF_NO_PI, verify non-zero MAC and IFF_UP. */
	int tap_fd = open("/dev/net/tun", O_RDWR | O_CLOEXEC);
	require(tap_fd >= 0, "open /dev/net/tun for IFF_TAP");
	struct ifreq tap_ifr;
	memset(&tap_ifr, 0, sizeof(tap_ifr));
	snprintf(tap_ifr.ifr_name, sizeof(tap_ifr.ifr_name), "taptest0");
	tap_ifr.ifr_flags = IFF_TAP | IFF_NO_PI;
	require(ioctl(tap_fd, TUNSETIFF, &tap_ifr) == 0, "TUNSETIFF IFF_TAP");

	require(ioctl(ctrl_fd, SIOCGIFHWADDR, &tap_ifr) == 0,
		"SIOCGIFHWADDR tap");
	int nonzero_mac = 0;
	for (int i = 0; i < 6; i++) {
		if ((uint8_t)tap_ifr.ifr_hwaddr.sa_data[i] != 0) {
			nonzero_mac = 1;
		}
	}
	require(nonzero_mac, "IFF_TAP MAC address is non-zero");

	require(ioctl(ctrl_fd, SIOCGIFFLAGS, &tap_ifr) == 0,
		"SIOCGIFFLAGS tap");
	tap_ifr.ifr_flags |= IFF_UP;
	require(ioctl(ctrl_fd, SIOCSIFFLAGS, &tap_ifr) == 0,
		"SIOCSIFFLAGS tap IFF_UP");

	require(close(tap_fd) == 0, "close tap_fd");
	require(close(udp_fd) == 0, "close udp_fd");
	require(close(ctrl_fd) == 0, "close ctrl_fd");
	require(close(tun_fd) == 0, "close tun_fd");

	puts("tun-tap runtime: IFF_TUN L3 bidirectional UDP, checksum and IFF_TAP MAC pass");
	return 0;
}
