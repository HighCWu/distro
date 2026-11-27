// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/inet_diag.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/sock_diag.h>
#include <linux/unix_diag.h>
#include <net/if.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static uint32_t next_seq = 1;

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "sockdiag-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static uint64_t socket_inode(int fd)
{
	struct stat st;
	require(fstat(fd, &st) == 0 && S_ISSOCK(st.st_mode) && st.st_ino > 0,
		"fstat socket inode");
	return (uint64_t)st.st_ino;
}

static void bring_up_loopback(void)
{
	int fd = socket(AF_INET, SOCK_DGRAM, 0);
	require(fd >= 0, "open ioctl socket");
	struct ifreq ifr;
	memset(&ifr, 0, sizeof(ifr));
	snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "lo");
	require(ioctl(fd, SIOCGIFFLAGS, &ifr) == 0, "SIOCGIFFLAGS lo");
	ifr.ifr_flags |= IFF_UP;
	require(ioctl(fd, SIOCSIFFLAGS, &ifr) == 0, "SIOCSIFFLAGS lo IFF_UP");
	require(close(fd) == 0, "close ioctl socket");
}

static void send_all(int fd, const char *data, size_t len)
{
	size_t done = 0;
	while (done < len) {
		ssize_t n = send(fd, data + done, len - done, 0);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "send fixture payload");
		done += (size_t)n;
	}
}

static void recv_expect(int fd, const char *expected)
{
	size_t len = strlen(expected);
	char buf[64] = { 0 };
	size_t done = 0;
	while (done < len) {
		ssize_t n = recv(fd, buf + done, len - done, 0);
		if (n < 0 && errno == EINTR) continue;
		require(n > 0, "recv fixture payload");
		done += (size_t)n;
	}
	require(strcmp(buf, expected) == 0, "recv payload matches");
}

static void check_inet_diag(int diag_fd, uint8_t family, uint16_t port_be,
			    uint64_t listen_ino, uint64_t est_ino,
			    uint32_t min_rqueue)
{
	struct {
		struct nlmsghdr nlh;
		struct inet_diag_req_v2 req;
	} query;
	memset(&query, 0, sizeof(query));
	query.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(query.req));
	query.nlh.nlmsg_type = SOCK_DIAG_BY_FAMILY;
	query.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
	query.nlh.nlmsg_seq = next_seq++;
	query.req.sdiag_family = family;
	query.req.sdiag_protocol = IPPROTO_TCP;
	query.req.idiag_states = (1u << TCP_LISTEN) | (1u << TCP_ESTABLISHED);

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(diag_fd, &query, query.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)query.nlh.nlmsg_len,
		"send inet_diag_req_v2");

	int saw_listen = 0;
	int saw_est = 0;

	for (;;) {
		char buf[8192];
		ssize_t n = recv(diag_fd, buf, sizeof(buf), 0);
		require(n > 0, "recv inet_diag dump");
		for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
		     NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
			if (nlh->nlmsg_type == NLMSG_DONE) {
				require(saw_listen && saw_est,
					"inet_diag observed both TCP_LISTEN and TCP_ESTABLISHED");
				return;
			}
			require(nlh->nlmsg_type == SOCK_DIAG_BY_FAMILY,
				"inet_diag message type");
			const struct inet_diag_msg *msg =
				(const struct inet_diag_msg *)NLMSG_DATA(nlh);
			require(msg->idiag_family == family,
				"inet_diag family matches");

			if (msg->idiag_inode == listen_ino) {
				require(msg->idiag_state == TCP_LISTEN,
					"listen socket has TCP_LISTEN");
				require(msg->id.idiag_sport == port_be,
					"listen socket sport matches");
				saw_listen = 1;
			} else if (msg->idiag_inode == est_ino) {
				require(msg->idiag_state == TCP_ESTABLISHED,
					"accepted socket has TCP_ESTABLISHED");
				require(msg->id.idiag_sport == port_be,
					"accepted socket sport matches");
				require(msg->idiag_rqueue >= min_rqueue,
					"accepted socket idiag_rqueue reflects queued bytes");
				saw_est = 1;
			}
		}
	}
}

static void check_unix_diag(int diag_fd, uint64_t listen_ino, uint64_t est_ino,
			    uint32_t min_rqueue)
{
	struct {
		struct nlmsghdr nlh;
		struct unix_diag_req req;
	} query;
	memset(&query, 0, sizeof(query));
	query.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(query.req));
	query.nlh.nlmsg_type = SOCK_DIAG_BY_FAMILY;
	query.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
	query.nlh.nlmsg_seq = next_seq++;
	query.req.sdiag_family = AF_UNIX;
	query.req.udiag_states = (1u << TCP_LISTEN) | (1u << TCP_ESTABLISHED);
	query.req.udiag_show = UDIAG_SHOW_NAME | UDIAG_SHOW_RQLEN;

	struct sockaddr_nl kernel = { .nl_family = AF_NETLINK };
	ssize_t sent = sendto(diag_fd, &query, query.nlh.nlmsg_len, 0,
			      (const struct sockaddr *)&kernel, sizeof(kernel));
	require(sent == (ssize_t)query.nlh.nlmsg_len, "send unix_diag_req");

	int saw_listen = 0;
	int saw_est = 0;

	for (;;) {
		char buf[8192];
		ssize_t n = recv(diag_fd, buf, sizeof(buf), 0);
		require(n > 0, "recv unix_diag dump");
		for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
		     NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
			if (nlh->nlmsg_type == NLMSG_DONE) {
				require(saw_listen && saw_est,
					"unix_diag observed both listener and accepted stream");
				return;
			}
			require(nlh->nlmsg_type == SOCK_DIAG_BY_FAMILY,
				"unix_diag message type");
			const struct unix_diag_msg *msg =
				(const struct unix_diag_msg *)NLMSG_DATA(nlh);
			require(msg->udiag_family == AF_UNIX,
				"unix_diag family matches");

			if (msg->udiag_ino == listen_ino) {
				require(msg->udiag_state == TCP_LISTEN,
					"unix listener has TCP_LISTEN");
				saw_listen = 1;
			} else if (msg->udiag_ino == est_ino) {
				require(msg->udiag_state == TCP_ESTABLISHED,
					"unix accepted has TCP_ESTABLISHED");
				int saw_rqlen = 0;
				int attr_len =
					(int)NLMSG_PAYLOAD(nlh, sizeof(*msg));
				const struct rtattr *rta =
					(const struct rtattr *)(((const char *)
									  msg) +
								NLMSG_ALIGN(sizeof(
									*msg)));
				for (; RTA_OK(rta, attr_len);
				     rta = RTA_NEXT(rta, attr_len)) {
					if (rta->rta_type == UNIX_DIAG_RQLEN &&
					    RTA_PAYLOAD(rta) ==
						    sizeof(struct
							   unix_diag_rqlen)) {
						struct unix_diag_rqlen rq;
						memcpy(&rq, RTA_DATA(rta),
						       sizeof(rq));
						require(rq.udiag_rqueue >=
								min_rqueue,
							"unix accepted udiag_rqueue reflects queued bytes");
						saw_rqlen = 1;
					}
				}
				require(saw_rqlen,
					"unix_diag includes UNIX_DIAG_RQLEN");
				saw_est = 1;
			}
		}
	}
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);
	bring_up_loopback();

	/* IPv4 TCP listener + connected pair with queued receive bytes. */
	int l4 = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
	require(l4 >= 0, "socket AF_INET listener");
	struct sockaddr_in a4 = { .sin_family = AF_INET,
				   .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
	require(bind(l4, (const struct sockaddr *)&a4, sizeof(a4)) == 0,
		"bind AF_INET listener");
	socklen_t len4 = sizeof(a4);
	require(getsockname(l4, (struct sockaddr *)&a4, &len4) == 0 &&
			a4.sin_port != 0,
		"getsockname AF_INET");
	require(listen(l4, 4) == 0, "listen AF_INET");

	int c4 = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
	require(c4 >= 0, "socket AF_INET client");
	require(connect(c4, (const struct sockaddr *)&a4, sizeof(a4)) == 0,
		"connect AF_INET");
	int acc4 = accept(l4, NULL, NULL);
	require(acc4 >= 0, "accept AF_INET");
	send_all(c4, "ping-v4", 7);

	/* IPv6 TCP listener + connected pair with queued receive bytes. */
	int l6 = socket(AF_INET6, SOCK_STREAM | SOCK_CLOEXEC, 0);
	require(l6 >= 0, "socket AF_INET6 listener");
	struct sockaddr_in6 a6 = { .sin6_family = AF_INET6,
				    .sin6_addr = IN6ADDR_LOOPBACK_INIT };
	require(bind(l6, (const struct sockaddr *)&a6, sizeof(a6)) == 0,
		"bind AF_INET6 listener");
	socklen_t len6 = sizeof(a6);
	require(getsockname(l6, (struct sockaddr *)&a6, &len6) == 0 &&
			a6.sin6_port != 0,
		"getsockname AF_INET6");
	require(listen(l6, 4) == 0, "listen AF_INET6");

	int c6 = socket(AF_INET6, SOCK_STREAM | SOCK_CLOEXEC, 0);
	require(c6 >= 0, "socket AF_INET6 client");
	require(connect(c6, (const struct sockaddr *)&a6, sizeof(a6)) == 0,
		"connect AF_INET6");
	int acc6 = accept(l6, NULL, NULL);
	require(acc6 >= 0, "accept AF_INET6");
	send_all(c6, "ping-v6", 7);

	/* AF_UNIX abstract stream listener + connected pair with queued bytes. */
	int lu = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	require(lu >= 0, "socket AF_UNIX listener");
	struct sockaddr_un au;
	memset(&au, 0, sizeof(au));
	au.sun_family = AF_UNIX;
	int name_len = snprintf(au.sun_path + 1, sizeof(au.sun_path) - 1,
				"sockdiag-runtime-%ld", (long)getpid());
	require(name_len > 0 && (size_t)name_len < sizeof(au.sun_path) - 1,
		"format abstract sun_path");
	socklen_t ulen = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 +
				     (size_t)name_len);
	require(bind(lu, (const struct sockaddr *)&au, ulen) == 0,
		"bind AF_UNIX abstract");
	require(listen(lu, 4) == 0, "listen AF_UNIX");

	int cu = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
	require(cu >= 0, "socket AF_UNIX client");
	require(connect(cu, (const struct sockaddr *)&au, ulen) == 0,
		"connect AF_UNIX");
	int accu = accept(lu, NULL, NULL);
	require(accu >= 0, "accept AF_UNIX");
	send_all(cu, "unix-q", 6);

	/* Query NETLINK_SOCK_DIAG across all three families. */
	int diag_fd =
		socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_SOCK_DIAG);
	require(diag_fd >= 0, "socket NETLINK_SOCK_DIAG");
	struct sockaddr_nl local = { .nl_family = AF_NETLINK };
	require(bind(diag_fd, (const struct sockaddr *)&local, sizeof(local)) ==
			0,
		"bind NETLINK_SOCK_DIAG");

	check_inet_diag(diag_fd, AF_INET, a4.sin_port, socket_inode(l4),
			socket_inode(acc4), 7);
	check_inet_diag(diag_fd, AF_INET6, a6.sin6_port, socket_inode(l6),
			socket_inode(acc6), 7);
	check_unix_diag(diag_fd, socket_inode(lu), socket_inode(accu), 1);

	recv_expect(acc4, "ping-v4");
	recv_expect(acc6, "ping-v6");
	recv_expect(accu, "unix-q");

	require(close(diag_fd) == 0, "close diag_fd");
	require(close(accu) == 0 && close(cu) == 0 && close(lu) == 0,
		"close AF_UNIX sockets");
	require(close(acc6) == 0 && close(c6) == 0 && close(l6) == 0,
		"close AF_INET6 sockets");
	require(close(acc4) == 0 && close(c4) == 0 && close(l4) == 0,
		"close AF_INET sockets");

	puts("sockdiag runtime: AF_INET/AF_INET6/AF_UNIX state, port, inode and rqueue pass");
	return 0;
}
