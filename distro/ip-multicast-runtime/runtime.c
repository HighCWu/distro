#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/if_addr.h>
#include <linux/if_link.h>
#include <linux/netlink.h>
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

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "ip-multicast-runtime: %s (errno=%d: %s)\n", what, errno,
          strerror(errno));
  exit(1);
}

static void bring_up_lo_multicast(void) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(fd >= 0, "socket(AF_INET, SOCK_DGRAM)");

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "lo");
  require(ioctl(fd, SIOCGIFFLAGS, &ifr) == 0, "SIOCGIFFLAGS lo");
  ifr.ifr_flags |= (short)(IFF_UP | IFF_RUNNING | IFF_MULTICAST);
  require(ioctl(fd, SIOCSIFFLAGS, &ifr) == 0, "SIOCSIFFLAGS lo");
  require(close(fd) == 0, "close ioctl fd");
}

static uint16_t test_ipv4_multicast(void) {
  int rx_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(rx_fd >= 0, "socket4 rx_fd");

  int reuse = 1;
  require(setsockopt(rx_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) ==
              0,
          "SO_REUSEADDR v4");

  struct sockaddr_in bind_addr;
  memset(&bind_addr, 0, sizeof(bind_addr));
  bind_addr.sin_family = AF_INET;
  bind_addr.sin_addr.s_addr = htonl(INADDR_ANY);
  require(bind(rx_fd, (const struct sockaddr *)&bind_addr, sizeof(bind_addr)) ==
              0,
          "bind rx_fd v4");

  socklen_t blen = sizeof(bind_addr);
  require(getsockname(rx_fd, (struct sockaddr *)&bind_addr, &blen) == 0,
          "getsockname rx_fd v4");
  uint16_t port = ntohs(bind_addr.sin_port);

  struct ip_mreq mreq;
  memset(&mreq, 0, sizeof(mreq));
  require(inet_pton(AF_INET, "239.255.1.1", &mreq.imr_multiaddr) == 1,
          "inet_pton 239.255.1.1");
  mreq.imr_interface.s_addr = htonl(INADDR_LOOPBACK);
  require(setsockopt(rx_fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq,
                     sizeof(mreq)) == 0,
          "IP_ADD_MEMBERSHIP");

  int tx_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(tx_fd >= 0, "socket4 tx_fd");

  struct in_addr lo_if;
  lo_if.s_addr = htonl(INADDR_LOOPBACK);
  require(setsockopt(tx_fd, IPPROTO_IP, IP_MULTICAST_IF, &lo_if,
                     sizeof(lo_if)) == 0,
          "IP_MULTICAST_IF");
  int loop = 1;
  require(setsockopt(tx_fd, IPPROTO_IP, IP_MULTICAST_LOOP, &loop,
                     sizeof(loop)) == 0,
          "IP_MULTICAST_LOOP");
  int ttl = 1;
  require(setsockopt(tx_fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl)) ==
              0,
          "IP_MULTICAST_TTL");

  struct sockaddr_in dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin_family = AF_INET;
  dst.sin_port = htons(port);
  dst.sin_addr = mreq.imr_multiaddr;

  const char msg1[] = "mcast4-hello";
  require(sendto(tx_fd, msg1, sizeof(msg1) - 1, 0,
                 (const struct sockaddr *)&dst,
                 sizeof(dst)) == (ssize_t)(sizeof(msg1) - 1),
          "sendto mcast4");

  char rbuf[32];
  ssize_t n = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(n == (ssize_t)(sizeof(msg1) - 1) &&
              memcmp(rbuf, msg1, sizeof(msg1) - 1) == 0,
          "recv mcast4 joined");

  require(setsockopt(rx_fd, IPPROTO_IP, IP_DROP_MEMBERSHIP, &mreq,
                     sizeof(mreq)) == 0,
          "IP_DROP_MEMBERSHIP");

  const char msg2[] = "mcast4-dropped";
  require(sendto(tx_fd, msg2, sizeof(msg2) - 1, 0,
                 (const struct sockaddr *)&dst,
                 sizeof(dst)) == (ssize_t)(sizeof(msg2) - 1),
          "sendto mcast4 after drop");
  n = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(n == -1 && (errno == EAGAIN || errno == EWOULDBLOCK),
          "recv mcast4 dropped EAGAIN");

  require(close(tx_fd) == 0, "close tx_fd v4");
  require(close(rx_fd) == 0, "close rx_fd v4");
  return port;
}

static uint32_t g_nl_seq = 1;

static void nl_add_attr(struct nlmsghdr *nlh, size_t maxlen, uint16_t type,
                        const void *data, size_t len) {
  size_t rta_len = RTA_LENGTH(len);
  size_t aligned_cur = NLMSG_ALIGN(nlh->nlmsg_len);
  require(aligned_cur + RTA_ALIGN(rta_len) <= maxlen, "nl attr fits");
  struct rtattr *rta = (struct rtattr *)((char *)nlh + aligned_cur);
  rta->rta_type = type;
  rta->rta_len = (unsigned short)rta_len;
  if (len > 0) {
    memcpy(RTA_DATA(rta), data, len);
  }
  nlh->nlmsg_len = (uint32_t)(aligned_cur + RTA_ALIGN(rta_len));
}

static struct rtattr *nl_nest_begin(struct nlmsghdr *nlh, size_t maxlen,
                                    uint16_t type) {
  struct rtattr *nest =
      (struct rtattr *)((char *)nlh + NLMSG_ALIGN(nlh->nlmsg_len));
  nl_add_attr(nlh, maxlen, type, NULL, 0);
  return nest;
}

static void nl_nest_end(struct nlmsghdr *nlh, struct rtattr *nest) {
  nest->rta_len = (unsigned short)(((char *)nlh + nlh->nlmsg_len) - (char *)nest);
}

static void nl_send_ack(int nl_fd, struct nlmsghdr *nlh, const char *ctx) {
  nlh->nlmsg_flags |= NLM_F_ACK;
  nlh->nlmsg_seq = g_nl_seq++;
  ssize_t sent = send(nl_fd, nlh, nlh->nlmsg_len, 0);
  require(sent == (ssize_t)nlh->nlmsg_len, ctx);

  char resp[4096];
  for (;;) {
    ssize_t n = recv(nl_fd, resp, sizeof(resp), 0);
    require(n > 0, "netlink ack recv");
    for (struct nlmsghdr *h = (struct nlmsghdr *)resp;
         NLMSG_OK(h, (unsigned int)n); h = NLMSG_NEXT(h, n)) {
      if (h->nlmsg_seq != nlh->nlmsg_seq) {
        continue;
      }
      if (h->nlmsg_type == NLMSG_ERROR) {
        struct nlmsgerr *err = (struct nlmsgerr *)NLMSG_DATA(h);
        if (err->error != 0) {
          errno = -err->error;
          require(0, ctx);
        }
        return;
      }
    }
  }
}

static unsigned int setup_dummy41_ipv6(int nl_fd) {
  char buf[512];
  memset(buf, 0, sizeof(buf));
  struct nlmsghdr *nlh = (struct nlmsghdr *)buf;
  nlh->nlmsg_len = NLMSG_LENGTH(sizeof(struct ifinfomsg));
  nlh->nlmsg_type = RTM_NEWLINK;
  nlh->nlmsg_flags = NLM_F_REQUEST | NLM_F_CREATE | NLM_F_EXCL;
  struct ifinfomsg *ifi = (struct ifinfomsg *)NLMSG_DATA(nlh);
  ifi->ifi_family = AF_UNSPEC;
  ifi->ifi_flags = IFF_UP | IFF_MULTICAST;
  ifi->ifi_change = IFF_UP | IFF_MULTICAST;
  nl_add_attr(nlh, sizeof(buf), IFLA_IFNAME, "dummy41", 8);
  struct rtattr *li = nl_nest_begin(nlh, sizeof(buf), IFLA_LINKINFO);
  nl_add_attr(nlh, sizeof(buf), IFLA_INFO_KIND, "dummy", 6);
  nl_nest_end(nlh, li);
  nl_send_ack(nl_fd, nlh, "RTM_NEWLINK dummy41");

  unsigned int dummy_idx = if_nametoindex("dummy41");
  require(dummy_idx != 0, "if_nametoindex(dummy41)");

  memset(buf, 0, sizeof(buf));
  nlh->nlmsg_len = NLMSG_LENGTH(sizeof(struct ifaddrmsg));
  nlh->nlmsg_type = RTM_NEWADDR;
  nlh->nlmsg_flags = NLM_F_REQUEST | NLM_F_CREATE | NLM_F_REPLACE;
  struct ifaddrmsg *ifa = (struct ifaddrmsg *)NLMSG_DATA(nlh);
  ifa->ifa_family = AF_INET6;
  ifa->ifa_prefixlen = 64;
  ifa->ifa_scope = RT_SCOPE_UNIVERSE;
  ifa->ifa_index = dummy_idx;
  struct in6_addr addr6;
  require(inet_pton(AF_INET6, "fd00:77::1", &addr6) == 1,
          "inet_pton fd00:77::1");
  nl_add_attr(nlh, sizeof(buf), IFA_LOCAL, &addr6, sizeof(addr6));
  uint32_t ifa_flags = IFA_F_NODAD;
  nl_add_attr(nlh, sizeof(buf), IFA_FLAGS, &ifa_flags, sizeof(ifa_flags));
  nl_send_ack(nl_fd, nlh, "RTM_NEWADDR dummy41 fd00:77::1/64");
  return dummy_idx;
}

static void teardown_dummy41(int nl_fd, unsigned int dummy_idx) {
  char buf[256];
  memset(buf, 0, sizeof(buf));
  struct nlmsghdr *nlh = (struct nlmsghdr *)buf;
  nlh->nlmsg_len = NLMSG_LENGTH(sizeof(struct ifinfomsg));
  nlh->nlmsg_type = RTM_DELLINK;
  nlh->nlmsg_flags = NLM_F_REQUEST;
  struct ifinfomsg *ifi = (struct ifinfomsg *)NLMSG_DATA(nlh);
  ifi->ifi_family = AF_UNSPEC;
  ifi->ifi_index = (int)dummy_idx;
  nl_send_ack(nl_fd, nlh, "RTM_DELLINK dummy41");
}

static uint16_t test_ipv6_multicast(void) {
  int nl_fd = socket(AF_NETLINK, SOCK_RAW, NETLINK_ROUTE);
  require(nl_fd >= 0, "socket AF_NETLINK");
  unsigned int dummy_idx = setup_dummy41_ipv6(nl_fd);

  int rx_fd = socket(AF_INET6, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(rx_fd >= 0, "socket6 rx_fd");

  int reuse = 1;
  require(setsockopt(rx_fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) ==
              0,
          "SO_REUSEADDR v6");

  struct sockaddr_in6 bind_addr;
  memset(&bind_addr, 0, sizeof(bind_addr));
  bind_addr.sin6_family = AF_INET6;
  bind_addr.sin6_addr = in6addr_any;
  require(bind(rx_fd, (const struct sockaddr *)&bind_addr, sizeof(bind_addr)) ==
              0,
          "bind rx_fd v6");

  socklen_t blen = sizeof(bind_addr);
  require(getsockname(rx_fd, (struct sockaddr *)&bind_addr, &blen) == 0,
          "getsockname rx_fd v6");
  uint16_t port = ntohs(bind_addr.sin6_port);

  struct ipv6_mreq mreq6;
  memset(&mreq6, 0, sizeof(mreq6));
  require(inet_pton(AF_INET6, "ff12::77", &mreq6.ipv6mr_multiaddr) == 1,
          "inet_pton ff12::77");
  mreq6.ipv6mr_interface = dummy_idx;
  require(setsockopt(rx_fd, IPPROTO_IPV6, IPV6_ADD_MEMBERSHIP, &mreq6,
                     sizeof(mreq6)) == 0,
          "IPV6_ADD_MEMBERSHIP");

  int tx_fd = socket(AF_INET6, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(tx_fd >= 0, "socket6 tx_fd");

  int ifidx = (int)dummy_idx;
  require(setsockopt(tx_fd, IPPROTO_IPV6, IPV6_MULTICAST_IF, &ifidx,
                     sizeof(ifidx)) == 0,
          "IPV6_MULTICAST_IF");
  int loop = 1;
  require(setsockopt(tx_fd, IPPROTO_IPV6, IPV6_MULTICAST_LOOP, &loop,
                     sizeof(loop)) == 0,
          "IPV6_MULTICAST_LOOP");
  int hops = 1;
  require(setsockopt(tx_fd, IPPROTO_IPV6, IPV6_MULTICAST_HOPS, &hops,
                     sizeof(hops)) == 0,
          "IPV6_MULTICAST_HOPS");

  struct sockaddr_in6 dst;
  memset(&dst, 0, sizeof(dst));
  dst.sin6_family = AF_INET6;
  dst.sin6_port = htons(port);
  dst.sin6_addr = mreq6.ipv6mr_multiaddr;
  dst.sin6_scope_id = dummy_idx;

  const char msg1[] = "mcast6-hello";
  require(sendto(tx_fd, msg1, sizeof(msg1) - 1, 0,
                 (const struct sockaddr *)&dst,
                 sizeof(dst)) == (ssize_t)(sizeof(msg1) - 1),
          "sendto mcast6");

  char rbuf[32];
  ssize_t n = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(n == (ssize_t)(sizeof(msg1) - 1) &&
              memcmp(rbuf, msg1, sizeof(msg1) - 1) == 0,
          "recv mcast6 joined");

  require(setsockopt(rx_fd, IPPROTO_IPV6, IPV6_DROP_MEMBERSHIP, &mreq6,
                     sizeof(mreq6)) == 0,
          "IPV6_DROP_MEMBERSHIP");

  const char msg2[] = "mcast6-dropped";
  require(sendto(tx_fd, msg2, sizeof(msg2) - 1, 0,
                 (const struct sockaddr *)&dst,
                 sizeof(dst)) == (ssize_t)(sizeof(msg2) - 1),
          "sendto mcast6 after drop");
  n = recv(rx_fd, rbuf, sizeof(rbuf), MSG_DONTWAIT);
  require(n == -1 && (errno == EAGAIN || errno == EWOULDBLOCK),
          "recv mcast6 dropped EAGAIN");

  require(close(tx_fd) == 0, "close tx_fd v6");
  require(close(rx_fd) == 0, "close rx_fd v6");
  teardown_dummy41(nl_fd, dummy_idx);
  require(close(nl_fd) == 0, "close netlink");
  return port;
}

int main(void) {
  bring_up_lo_multicast();
  uint16_t p4 = test_ipv4_multicast();
  uint16_t p6 = test_ipv6_multicast();

  printf("ip-multicast-runtime: ok p4=%u p6=%u\n", p4, p6);
  return 0;
}
