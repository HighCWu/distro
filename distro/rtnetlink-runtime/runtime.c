// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/fib_rules.h>
#include <linux/if_addr.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static uint32_t next_seq = 1;

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "rtnetlink-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static void add_attr(struct nlmsghdr *nlh, size_t maxlen, int type,
		     const void *data, size_t len)
{
	size_t rta_len = RTA_LENGTH(len);
	require(NLMSG_ALIGN(nlh->nlmsg_len) + RTA_ALIGN(rta_len) <= maxlen,
		"netlink message buffer capacity");
	struct rtattr *rta =
		(struct rtattr *)(((char *)nlh) + NLMSG_ALIGN(nlh->nlmsg_len));
	rta->rta_type = (unsigned short)type;
	rta->rta_len = (unsigned short)rta_len;
	if (len > 0) memcpy(RTA_DATA(rta), data, len);
	nlh->nlmsg_len = (uint32_t)(NLMSG_ALIGN(nlh->nlmsg_len) + RTA_ALIGN(rta_len));
}

static void send_and_expect_ack(int fd, struct nlmsghdr *nlh, const char *what)
{
	nlh->nlmsg_seq = next_seq++;
	nlh->nlmsg_pid = 0;

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(fd, nlh, nlh->nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)nlh->nlmsg_len, what);

	char buf[4096];
	ssize_t n = recv(fd, buf, sizeof(buf), 0);
	require(n >= (ssize_t)sizeof(struct nlmsghdr), what);

	const struct nlmsghdr *resp = (const struct nlmsghdr *)buf;
	require(NLMSG_OK(resp, (size_t)n), what);
	require(resp->nlmsg_type == NLMSG_ERROR, what);
	const struct nlmsgerr *err = (const struct nlmsgerr *)NLMSG_DATA(resp);
	if (err->error != 0) {
		errno = -err->error;
		require(0, what);
	}
}

static void bring_up_loopback(void)
{
	int ioctl_fd = socket(AF_INET, SOCK_DGRAM, 0);
	require(ioctl_fd >= 0, "open ioctl socket");

	struct ifreq ifr;
	memset(&ifr, 0, sizeof(ifr));
	snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "lo");
	require(ioctl(ioctl_fd, SIOCGIFFLAGS, &ifr) == 0, "SIOCGIFFLAGS lo");
	ifr.ifr_flags |= IFF_UP;
	require(ioctl(ioctl_fd, SIOCSIFFLAGS, &ifr) == 0, "SIOCSIFFLAGS lo IFF_UP");
	require(close(ioctl_fd) == 0, "close ioctl socket");
}

static void add_ipv6_addr(int nl_fd, uint32_t ifindex, const char *addr_str)
{
	struct {
		struct nlmsghdr nlh;
		struct ifaddrmsg ifa;
		char attrs[128];
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.ifa));
	req.nlh.nlmsg_type = RTM_NEWADDR;
	req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
	req.ifa.ifa_family = AF_INET6;
	req.ifa.ifa_prefixlen = 64;
	req.ifa.ifa_scope = RT_SCOPE_UNIVERSE;
	req.ifa.ifa_index = ifindex;

	struct in6_addr addr;
	require(inet_pton(AF_INET6, addr_str, &addr) == 1, "inet_pton addr");
	add_attr(&req.nlh, sizeof(req), IFA_LOCAL, &addr, sizeof(addr));
	send_and_expect_ack(nl_fd, &req.nlh, "RTM_NEWADDR");
}

static void modify_route(int nl_fd, int add, uint32_t table, uint8_t rtm_type,
			 const char *dst_str, uint32_t ifindex)
{
	struct {
		struct nlmsghdr nlh;
		struct rtmsg rtm;
		char attrs[256];
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
	req.nlh.nlmsg_type = add ? RTM_NEWROUTE : RTM_DELROUTE;
	req.nlh.nlmsg_flags =
		NLM_F_REQUEST | NLM_F_ACK | (add ? (NLM_F_CREATE | NLM_F_EXCL) : 0);
	req.rtm.rtm_family = AF_INET6;
	req.rtm.rtm_dst_len = 64;
	req.rtm.rtm_table = RT_TABLE_UNSPEC;
	req.rtm.rtm_protocol = RTPROT_STATIC;
	req.rtm.rtm_scope = RT_SCOPE_UNIVERSE;
	req.rtm.rtm_type = rtm_type;

	struct in6_addr dst;
	require(inet_pton(AF_INET6, dst_str, &dst) == 1, "inet_pton route dst");
	add_attr(&req.nlh, sizeof(req), RTA_DST, &dst, sizeof(dst));
	add_attr(&req.nlh, sizeof(req), RTA_TABLE, &table, sizeof(table));
	if (ifindex != 0) {
		add_attr(&req.nlh, sizeof(req), RTA_OIF, &ifindex, sizeof(ifindex));
	}
	send_and_expect_ack(nl_fd, &req.nlh, add ? "RTM_NEWROUTE" : "RTM_DELROUTE");
}

static void modify_rule(int nl_fd, int add, uint32_t priority, uint32_t table,
			const char *src_str)
{
	struct {
		struct nlmsghdr nlh;
		struct fib_rule_hdr frh;
		char attrs[256];
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.frh));
	req.nlh.nlmsg_type = add ? RTM_NEWRULE : RTM_DELRULE;
	req.nlh.nlmsg_flags =
		NLM_F_REQUEST | NLM_F_ACK | (add ? (NLM_F_CREATE | NLM_F_EXCL) : 0);
	req.frh.family = AF_INET6;
	req.frh.src_len = 128;
	req.frh.table = RT_TABLE_UNSPEC;
	req.frh.action = FR_ACT_TO_TBL;

	struct in6_addr src;
	require(inet_pton(AF_INET6, src_str, &src) == 1, "inet_pton rule src");
	add_attr(&req.nlh, sizeof(req), FRA_SRC, &src, sizeof(src));
	add_attr(&req.nlh, sizeof(req), FRA_PRIORITY, &priority, sizeof(priority));
	add_attr(&req.nlh, sizeof(req), FRA_TABLE, &table, sizeof(table));
	send_and_expect_ack(nl_fd, &req.nlh, add ? "RTM_NEWRULE" : "RTM_DELRULE");
}

static void query_route_expect(int nl_fd, const char *src_str, const char *dst_str,
			       uint32_t expected_table, uint8_t expected_type)
{
	struct {
		struct nlmsghdr nlh;
		struct rtmsg rtm;
		char attrs[256];
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
	req.nlh.nlmsg_type = RTM_GETROUTE;
	req.nlh.nlmsg_flags = NLM_F_REQUEST;
	req.nlh.nlmsg_seq = next_seq++;
	req.rtm.rtm_family = AF_INET6;
	req.rtm.rtm_dst_len = 128;
	req.rtm.rtm_src_len = 128;

	struct in6_addr dst;
	struct in6_addr src;
	require(inet_pton(AF_INET6, dst_str, &dst) == 1, "inet_pton query dst");
	require(inet_pton(AF_INET6, src_str, &src) == 1, "inet_pton query src");
	add_attr(&req.nlh, sizeof(req), RTA_DST, &dst, sizeof(dst));
	add_attr(&req.nlh, sizeof(req), RTA_SRC, &src, sizeof(src));

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)req.nlh.nlmsg_len, "send RTM_GETROUTE");

	char buf[4096];
	ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
	require(n >= (ssize_t)sizeof(struct nlmsghdr), "recv RTM_GETROUTE");

	const struct nlmsghdr *resp = (const struct nlmsghdr *)buf;
	require(NLMSG_OK(resp, (size_t)n), "valid RTM_GETROUTE response");
	require(resp->nlmsg_type == RTM_NEWROUTE, "RTM_GETROUTE returned RTM_NEWROUTE");

	const struct rtmsg *rtm = (const struct rtmsg *)NLMSG_DATA(resp);
	require(rtm->rtm_type == expected_type, "matched expected route type");

	uint32_t got_table = rtm->rtm_table;
	int attr_len = (int)RTM_PAYLOAD(resp);
	for (const struct rtattr *rta = RTM_RTA(rtm); RTA_OK(rta, attr_len);
	     rta = RTA_NEXT(rta, attr_len)) {
		if (rta->rta_type == RTA_TABLE && RTA_PAYLOAD(rta) == sizeof(uint32_t)) {
			memcpy(&got_table, RTA_DATA(rta), sizeof(got_table));
		}
	}
	require(got_table == expected_table, "matched expected policy routing table");
}

static void verify_rule_dump(int nl_fd, uint32_t table_a, uint32_t table_b)
{
	struct {
		struct nlmsghdr nlh;
		struct fib_rule_hdr frh;
	} req;
	memset(&req, 0, sizeof(req));
	req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.frh));
	req.nlh.nlmsg_type = RTM_GETRULE;
	req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
	req.nlh.nlmsg_seq = next_seq++;
	req.frh.family = AF_INET6;

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)req.nlh.nlmsg_len, "send RTM_GETRULE dump");

	int saw_a = 0;
	int saw_b = 0;
	for (;;) {
		char buf[8192];
		ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
		require(n > 0, "recv RTM_GETRULE dump");
		for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
		     NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
			if (nlh->nlmsg_type == NLMSG_DONE) {
				require(saw_a && saw_b, "RTM_GETRULE dump contains both policy rules");
				return;
			}
			require(nlh->nlmsg_type == RTM_NEWRULE, "RTM_GETRULE record");
			const struct fib_rule_hdr *frh =
				(const struct fib_rule_hdr *)NLMSG_DATA(nlh);
			uint32_t table = frh->table;
			int attr_len = (int)NLMSG_PAYLOAD(nlh, sizeof(*frh));
			const struct rtattr *rta =
				(const struct rtattr *)(((const char *)frh) +
							NLMSG_ALIGN(sizeof(*frh)));
			for (; RTA_OK(rta, attr_len); rta = RTA_NEXT(rta, attr_len)) {
				if (rta->rta_type == FRA_TABLE &&
				    RTA_PAYLOAD(rta) == sizeof(uint32_t)) {
					memcpy(&table, RTA_DATA(rta), sizeof(table));
				}
			}
			if (table == table_a) saw_a = 1;
			if (table == table_b) saw_b = 1;
		}
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	bring_up_loopback();
	uint32_t lo_index = if_nametoindex("lo");
	require(lo_index > 0, "if_nametoindex(lo)");

	int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
	require(nl_fd >= 0, "socket(AF_NETLINK, NETLINK_ROUTE)");

	struct sockaddr_nl local = { .nl_family = AF_NETLINK };
	require(bind(nl_fd, (const struct sockaddr *)&local, sizeof(local)) == 0,
		"bind NETLINK_ROUTE socket");

	add_ipv6_addr(nl_fd, lo_index, "fd00:1::1");
	add_ipv6_addr(nl_fd, lo_index, "fd00:2::1");

	const uint32_t table_unicast = 100;
	const uint32_t table_blackhole = 200;

	modify_route(nl_fd, 1, table_unicast, RTN_UNICAST, "fd00:3::", lo_index);
	modify_route(nl_fd, 1, table_blackhole, RTN_BLACKHOLE, "fd00:3::", 0);

	modify_rule(nl_fd, 1, 100, table_unicast, "fd00:1::1");
	modify_rule(nl_fd, 1, 101, table_blackhole, "fd00:2::1");

	verify_rule_dump(nl_fd, table_unicast, table_blackhole);
	query_route_expect(nl_fd, "fd00:1::1", "fd00:3::1", table_unicast, RTN_UNICAST);
	query_route_expect(nl_fd, "fd00:2::1", "fd00:3::1", table_blackhole, RTN_BLACKHOLE);

	modify_rule(nl_fd, 0, 100, table_unicast, "fd00:1::1");
	modify_rule(nl_fd, 0, 101, table_blackhole, "fd00:2::1");
	modify_route(nl_fd, 0, table_unicast, RTN_UNICAST, "fd00:3::", lo_index);
	modify_route(nl_fd, 0, table_blackhole, RTN_BLACKHOLE, "fd00:3::", 0);

	require(close(nl_fd) == 0, "close NETLINK_ROUTE socket");
	puts("rtnetlink runtime: IPv6 policy rules and multi-table route lookup pass");
	return 0;
}
