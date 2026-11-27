#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_link.h>
#include <linux/rtnetlink.h>
#include <linux/veth.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static uint32_t next_seq = 1;

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "veth-netns-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void add_attr(struct nlmsghdr *nlh, size_t maxlen, int type,
                     const void *data, size_t len) {
  size_t rta_len = RTA_LENGTH(len);
  require(NLMSG_ALIGN(nlh->nlmsg_len) + RTA_ALIGN(rta_len) <= maxlen,
          "netlink buffer capacity");
  struct rtattr *rta =
      (struct rtattr *)(((char *)nlh) + NLMSG_ALIGN(nlh->nlmsg_len));
  rta->rta_type = (unsigned short)type;
  rta->rta_len = (unsigned short)rta_len;
  if (len > 0) {
    memcpy(RTA_DATA(rta), data, len);
  }
  nlh->nlmsg_len =
      (uint32_t)(NLMSG_ALIGN(nlh->nlmsg_len) + RTA_ALIGN(rta_len));
}

static struct rtattr *nest_begin(struct nlmsghdr *nlh, size_t maxlen,
                                 int type) {
  struct rtattr *nest =
      (struct rtattr *)(((char *)nlh) + NLMSG_ALIGN(nlh->nlmsg_len));
  add_attr(nlh, maxlen, type, NULL, 0);
  return nest;
}

static void nest_end(struct nlmsghdr *nlh, struct rtattr *nest) {
  nest->rta_len = (unsigned short)(((char *)nlh + NLMSG_ALIGN(nlh->nlmsg_len)) -
                                   (char *)nest);
}

static void send_and_expect_ack(int fd, struct nlmsghdr *nlh,
                                const char *what) {
  nlh->nlmsg_seq = next_seq++;
  nlh->nlmsg_pid = 0;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
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

static void create_veth_pair(int nl_fd, int peer_ns_fd) {
  struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
    char attrs[512];
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.ifi));
  req.nlh.nlmsg_type = RTM_NEWLINK;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
  req.ifi.ifi_family = AF_UNSPEC;

  add_attr(&req.nlh, sizeof(req), IFLA_IFNAME, "veth0", sizeof("veth0"));

  struct rtattr *linkinfo = nest_begin(&req.nlh, sizeof(req), IFLA_LINKINFO);
  add_attr(&req.nlh, sizeof(req), IFLA_INFO_KIND, "veth", sizeof("veth") - 1);

  struct rtattr *infodata = nest_begin(&req.nlh, sizeof(req), IFLA_INFO_DATA);
  struct rtattr *peer = nest_begin(&req.nlh, sizeof(req), VETH_INFO_PEER);

  struct ifinfomsg peer_ifi;
  memset(&peer_ifi, 0, sizeof(peer_ifi));
  peer_ifi.ifi_family = AF_UNSPEC;
  require(NLMSG_ALIGN(req.nlh.nlmsg_len) + NLMSG_ALIGN(sizeof(peer_ifi)) <=
              sizeof(req),
          "peer ifinfomsg");
  memcpy(((char *)&req.nlh) + NLMSG_ALIGN(req.nlh.nlmsg_len), &peer_ifi,
         sizeof(peer_ifi));
  req.nlh.nlmsg_len = (uint32_t)(NLMSG_ALIGN(req.nlh.nlmsg_len) +
                                 NLMSG_ALIGN(sizeof(peer_ifi)));

  add_attr(&req.nlh, sizeof(req), IFLA_IFNAME, "veth1", sizeof("veth1"));
  uint32_t ns_fd_u32 = (uint32_t)peer_ns_fd;
  add_attr(&req.nlh, sizeof(req), IFLA_NET_NS_FD, &ns_fd_u32,
           sizeof(ns_fd_u32));

  nest_end(&req.nlh, peer);
  nest_end(&req.nlh, infodata);
  nest_end(&req.nlh, linkinfo);

  send_and_expect_ack(nl_fd, &req.nlh, "RTM_NEWLINK veth0/veth1");
}

static void delete_link_by_name(int nl_fd, const char *ifname) {
  unsigned int ifindex = if_nametoindex(ifname);
  require(ifindex != 0, "if_nametoindex");

  struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.ifi));
  req.nlh.nlmsg_type = RTM_DELLINK;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
  req.ifi.ifi_family = AF_UNSPEC;
  req.ifi.ifi_index = (int)ifindex;

  send_and_expect_ack(nl_fd, &req.nlh, "RTM_DELLINK");
}

static void set_iface_up_ipv4(const char *ifname, const char *ip_str,
                              const char *mask_str) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(fd >= 0, "socket(AF_INET, SOCK_DGRAM)");

  struct ifreq ifr;
  if (ip_str != NULL) {
    memset(&ifr, 0, sizeof(ifr));
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
    struct sockaddr_in *sin = (struct sockaddr_in *)&ifr.ifr_addr;
    sin->sin_family = AF_INET;
    require(inet_pton(AF_INET, ip_str, &sin->sin_addr) == 1, "inet_pton ip");
    require(ioctl(fd, SIOCSIFADDR, &ifr) == 0, "SIOCSIFADDR");
  }
  if (mask_str != NULL) {
    memset(&ifr, 0, sizeof(ifr));
    snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
    struct sockaddr_in *sin = (struct sockaddr_in *)&ifr.ifr_netmask;
    sin->sin_family = AF_INET;
    require(inet_pton(AF_INET, mask_str, &sin->sin_addr) == 1,
            "inet_pton mask");
    require(ioctl(fd, SIOCSIFNETMASK, &ifr) == 0, "SIOCSIFNETMASK");
  }

  memset(&ifr, 0, sizeof(ifr));
  snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
  require(ioctl(fd, SIOCGIFFLAGS, &ifr) == 0, "SIOCGIFFLAGS");
  ifr.ifr_flags |= (short)(IFF_UP | IFF_RUNNING);
  require(ioctl(fd, SIOCSIFFLAGS, &ifr) == 0, "SIOCSIFFLAGS");

  require(close(fd) == 0, "close ioctl fd");
}

static int bind_ipv4_ephemeral(int sock_type, const char *ip_str,
                               uint16_t *out_port) {
  int fd = socket(AF_INET, sock_type | SOCK_CLOEXEC, 0);
  require(fd >= 0, "socket");

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = 0;
  require(inet_pton(AF_INET, ip_str, &addr.sin_addr) == 1, "inet_pton bind");
  require(bind(fd, (const struct sockaddr *)&addr, sizeof(addr)) == 0, "bind");

  socklen_t alen = sizeof(addr);
  require(getsockname(fd, (struct sockaddr *)&addr, &alen) == 0, "getsockname");
  *out_port = ntohs(addr.sin_port);
  return fd;
}

int main(void) {
  int orig_ns_fd = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  require(orig_ns_fd >= 0, "open orig /proc/self/ns/net");

  require(unshare(CLONE_NEWNET) == 0, "unshare(CLONE_NEWNET)");
  int peer_ns_fd = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  require(peer_ns_fd >= 0, "open peer /proc/self/ns/net");

  require(setns(orig_ns_fd, CLONE_NEWNET) == 0, "setns(orig_ns_fd)");

  int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
  require(nl_fd >= 0, "socket(AF_NETLINK)");

  create_veth_pair(nl_fd, peer_ns_fd);
  set_iface_up_ipv4("veth0", "10.88.0.1", "255.255.255.0");

  require(setns(peer_ns_fd, CLONE_NEWNET) == 0, "setns(peer_ns_fd)");
  set_iface_up_ipv4("lo", NULL, NULL);
  set_iface_up_ipv4("veth1", "10.88.0.2", "255.255.255.0");

  uint16_t udp_b_port = 0;
  int udp_b = bind_ipv4_ephemeral(SOCK_DGRAM, "10.88.0.2", &udp_b_port);

  uint16_t tcp_port = 0;
  int tcp_listen = bind_ipv4_ephemeral(SOCK_STREAM, "10.88.0.2", &tcp_port);
  require(listen(tcp_listen, 4) == 0, "listen(tcp_listen)");

  require(setns(orig_ns_fd, CLONE_NEWNET) == 0, "setns(orig_ns_fd back)");

  uint16_t udp_a_port = 0;
  int udp_a = bind_ipv4_ephemeral(SOCK_DGRAM, "10.88.0.1", &udp_a_port);

  struct sockaddr_in dst_b;
  memset(&dst_b, 0, sizeof(dst_b));
  dst_b.sin_family = AF_INET;
  dst_b.sin_port = htons(udp_b_port);
  require(inet_pton(AF_INET, "10.88.0.2", &dst_b.sin_addr) == 1,
          "inet_pton dst_b");

  const char ping[] = "veth-udp-ping";
  ssize_t n = sendto(udp_a, ping, sizeof(ping) - 1, 0,
                     (const struct sockaddr *)&dst_b, sizeof(dst_b));
  require(n == (ssize_t)(sizeof(ping) - 1), "sendto udp_a -> udp_b");

  char buf[64];
  struct sockaddr_in src;
  socklen_t slen = sizeof(src);
  memset(&src, 0, sizeof(src));
  n = recvfrom(udp_b, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&src, &slen);
  require(n == (ssize_t)(sizeof(ping) - 1), "recvfrom udp_b");
  buf[n] = '\0';
  require(memcmp(buf, ping, sizeof(ping) - 1) == 0, "udp ping payload");
  require(src.sin_addr.s_addr == htonl(0x0a580001U), "udp ping src ip");

  const char pong[] = "veth-udp-pong";
  n = sendto(udp_b, pong, sizeof(pong) - 1, 0, (const struct sockaddr *)&src,
             slen);
  require(n == (ssize_t)(sizeof(pong) - 1), "sendto udp_b -> udp_a");

  slen = sizeof(src);
  memset(&src, 0, sizeof(src));
  n = recvfrom(udp_a, buf, sizeof(buf) - 1, 0, (struct sockaddr *)&src, &slen);
  require(n == (ssize_t)(sizeof(pong) - 1), "recvfrom udp_a");
  buf[n] = '\0';
  require(memcmp(buf, pong, sizeof(pong) - 1) == 0, "udp pong payload");
  require(src.sin_addr.s_addr == htonl(0x0a580002U), "udp pong src ip");

  int tcp_client = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  require(tcp_client >= 0, "socket tcp_client");
  struct sockaddr_in tcp_dst;
  memset(&tcp_dst, 0, sizeof(tcp_dst));
  tcp_dst.sin_family = AF_INET;
  tcp_dst.sin_port = htons(tcp_port);
  require(inet_pton(AF_INET, "10.88.0.2", &tcp_dst.sin_addr) == 1,
          "inet_pton tcp_dst");
  require(connect(tcp_client, (const struct sockaddr *)&tcp_dst,
                  sizeof(tcp_dst)) == 0,
          "connect tcp_client");

  int tcp_server = accept(tcp_listen, NULL, NULL);
  require(tcp_server >= 0, "accept tcp_listen");

  const char tcp_hello[] = "veth-tcp-hello";
  require(send(tcp_client, tcp_hello, sizeof(tcp_hello) - 1, 0) ==
              (ssize_t)(sizeof(tcp_hello) - 1),
          "send tcp_client");
  n = recv(tcp_server, buf, sizeof(buf) - 1, 0);
  require(n == (ssize_t)(sizeof(tcp_hello) - 1), "recv tcp_server");
  require(memcmp(buf, tcp_hello, sizeof(tcp_hello) - 1) == 0,
          "tcp_hello payload");

  const char tcp_ack[] = "veth-tcp-ack";
  require(send(tcp_server, tcp_ack, sizeof(tcp_ack) - 1, 0) ==
              (ssize_t)(sizeof(tcp_ack) - 1),
          "send tcp_server");
  n = recv(tcp_client, buf, sizeof(buf) - 1, 0);
  require(n == (ssize_t)(sizeof(tcp_ack) - 1), "recv tcp_client");
  require(memcmp(buf, tcp_ack, sizeof(tcp_ack) - 1) == 0, "tcp_ack payload");

  require(close(tcp_client) == 0, "close tcp_client");
  require(close(tcp_server) == 0, "close tcp_server");
  require(close(tcp_listen) == 0, "close tcp_listen");
  require(close(udp_a) == 0, "close udp_a");
  require(close(udp_b) == 0, "close udp_b");

  delete_link_by_name(nl_fd, "veth0");

  require(close(nl_fd) == 0, "close nl_fd");
  require(close(peer_ns_fd) == 0, "close peer_ns_fd");
  require(close(orig_ns_fd) == 0, "close orig_ns_fd");

  printf("veth-netns-runtime: ok udp=%u/%u tcp=%u\n", udp_a_port, udp_b_port,
         tcp_port);
  return 0;
}
