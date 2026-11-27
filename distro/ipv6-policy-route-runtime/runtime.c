#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/fib_rules.h>
#include <linux/if_addr.h>
#include <linux/if_link.h>
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

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "ipv6-policy-route-runtime: %s (errno=%d: %s)\n", what,
          errno, strerror(errno));
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

static void create_dummy(int nl_fd, const char *ifname) {
  struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
    char attrs[256];
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.ifi));
  req.nlh.nlmsg_type = RTM_NEWLINK;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
  req.ifi.ifi_family = AF_UNSPEC;

  add_attr(&req.nlh, sizeof(req), IFLA_IFNAME, ifname, strlen(ifname) + 1);
  struct rtattr *linkinfo = nest_begin(&req.nlh, sizeof(req), IFLA_LINKINFO);
  add_attr(&req.nlh, sizeof(req), IFLA_INFO_KIND, "dummy", sizeof("dummy") - 1);
  nest_end(&req.nlh, linkinfo);

  send_and_expect_ack(nl_fd, &req.nlh, "RTM_NEWLINK dummy");
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

static void set_iface_up(const char *ifname) {
  int fd = socket(AF_INET6, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(fd >= 0, "socket(AF_INET6, SOCK_DGRAM)");

  struct ifreq ifr;
  memset(&ifr, 0, sizeof(ifr));
  snprintf(ifr.ifr_name, sizeof(ifr.ifr_name), "%s", ifname);
  require(ioctl(fd, SIOCGIFFLAGS, &ifr) == 0, "SIOCGIFFLAGS");
  ifr.ifr_flags |= (short)(IFF_UP | IFF_RUNNING);
  require(ioctl(fd, SIOCSIFFLAGS, &ifr) == 0, "SIOCSIFFLAGS");
  require(close(fd) == 0, "close ioctl fd");
}

static void add_ipv6_addr_nodad(int nl_fd, uint32_t ifindex,
                                const char *addr_str) {
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
  req.ifa.ifa_flags = IFA_F_NODAD;
  req.ifa.ifa_scope = RT_SCOPE_UNIVERSE;
  req.ifa.ifa_index = ifindex;

  struct in6_addr addr;
  require(inet_pton(AF_INET6, addr_str, &addr) == 1, "inet_pton addr");
  add_attr(&req.nlh, sizeof(req), IFA_LOCAL, &addr, sizeof(addr));
  uint32_t flags32 = IFA_F_NODAD;
  add_attr(&req.nlh, sizeof(req), IFA_FLAGS, &flags32, sizeof(flags32));

  send_and_expect_ack(nl_fd, &req.nlh, "RTM_NEWADDR");
}

static void route6_op(int nl_fd, uint16_t type, uint16_t flags, uint32_t table,
                      const char *dst_str, uint8_t dst_len, uint32_t oif) {
  struct {
    struct nlmsghdr nlh;
    struct rtmsg rtm;
    char attrs[128];
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
  req.nlh.nlmsg_type = type;
  req.nlh.nlmsg_flags = flags;
  req.rtm.rtm_family = AF_INET6;
  req.rtm.rtm_dst_len = dst_len;
  req.rtm.rtm_table = RT_TABLE_UNSPEC;
  req.rtm.rtm_protocol = RTPROT_BOOT;
  req.rtm.rtm_scope = RT_SCOPE_UNIVERSE;
  req.rtm.rtm_type = RTN_UNICAST;

  struct in6_addr dst;
  require(inet_pton(AF_INET6, dst_str, &dst) == 1, "inet_pton dst6");
  add_attr(&req.nlh, sizeof(req), RTA_DST, &dst, sizeof(dst));
  add_attr(&req.nlh, sizeof(req), RTA_TABLE, &table, sizeof(table));
  add_attr(&req.nlh, sizeof(req), RTA_OIF, &oif, sizeof(oif));

  send_and_expect_ack(nl_fd, &req.nlh,
                      type == RTM_NEWROUTE ? "RTM_NEWROUTE6" : "RTM_DELROUTE6");
}

static void rule6_op(int nl_fd, uint16_t type, uint16_t flags, uint32_t prio,
                     uint32_t table, const char *src_str) {
  struct {
    struct nlmsghdr nlh;
    struct fib_rule_hdr frh;
    char attrs[128];
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.frh));
  req.nlh.nlmsg_type = type;
  req.nlh.nlmsg_flags = flags;
  req.frh.family = AF_INET6;
  req.frh.src_len = 128;
  req.frh.table = RT_TABLE_UNSPEC;
  req.frh.action = FR_ACT_TO_TBL;

  struct in6_addr src;
  require(inet_pton(AF_INET6, src_str, &src) == 1, "inet_pton src6");
  add_attr(&req.nlh, sizeof(req), FRA_SRC, &src, sizeof(src));
  add_attr(&req.nlh, sizeof(req), FRA_PRIORITY, &prio, sizeof(prio));
  add_attr(&req.nlh, sizeof(req), FRA_TABLE, &table, sizeof(table));

  send_and_expect_ack(nl_fd, &req.nlh,
                      type == RTM_NEWRULE ? "RTM_NEWRULE6" : "RTM_DELRULE6");
}

static void verify_rules6_present(int nl_fd, const char *src1,
                                  const char *src2) {
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

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto RTM_GETRULE6");

  struct in6_addr exp1, exp2;
  require(inet_pton(AF_INET6, src1, &exp1) == 1, "inet_pton exp1");
  require(inet_pton(AF_INET6, src2, &exp2) == 1, "inet_pton exp2");

  int found1 = 0;
  int found2 = 0;
  int done = 0;
  char buf[8192];
  while (!done) {
    ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
    require(n > 0, "recv RTM_GETRULE6");
    for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
         NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
      if (nlh->nlmsg_type == NLMSG_DONE) {
        done = 1;
        break;
      }
      require(nlh->nlmsg_type != NLMSG_ERROR, "RTM_GETRULE6 error");
      if (nlh->nlmsg_type != RTM_NEWRULE) {
        continue;
      }
      const struct fib_rule_hdr *frh =
          (const struct fib_rule_hdr *)NLMSG_DATA(nlh);
      uint32_t prio = 0;
      uint32_t table = frh->table;
      struct in6_addr src_ip;
      int has_src = 0;
      memset(&src_ip, 0, sizeof(src_ip));
      int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*frh));
      for (const struct rtattr *rta =
               (const struct rtattr *)(((const char *)frh) +
                                       NLMSG_ALIGN(sizeof(*frh)));
           RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
        if (rta->rta_type == FRA_PRIORITY && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&prio, RTA_DATA(rta), 4);
        } else if (rta->rta_type == FRA_TABLE && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&table, RTA_DATA(rta), 4);
        } else if (rta->rta_type == FRA_SRC && RTA_PAYLOAD(rta) == 16) {
          memcpy(&src_ip, RTA_DATA(rta), 16);
          has_src = 1;
        }
      }
      if (has_src && prio == 2001 && table == 201 &&
          memcmp(&src_ip, &exp1, 16) == 0) {
        found1 = 1;
      }
      if (has_src && prio == 2002 && table == 202 &&
          memcmp(&src_ip, &exp2, 16) == 0) {
        found2 = 1;
      }
    }
  }
  require(found1 && found2, "IPv6 policy rules 2001/2002 readback");
}

static void verify_routes6_present(int nl_fd, uint32_t oif20, uint32_t oif21) {
  struct {
    struct nlmsghdr nlh;
    struct rtmsg rtm;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
  req.nlh.nlmsg_type = RTM_GETROUTE;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  req.nlh.nlmsg_seq = next_seq++;
  req.rtm.rtm_family = AF_INET6;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto RTM_GETROUTE6");

  struct in6_addr dst1, dst2;
  require(inet_pton(AF_INET6, "fd99:201::", &dst1) == 1, "inet_pton dst1");
  require(inet_pton(AF_INET6, "fd99:202::", &dst2) == 1, "inet_pton dst2");

  int found1 = 0;
  int found2 = 0;
  int done = 0;
  char buf[8192];
  while (!done) {
    ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
    require(n > 0, "recv RTM_GETROUTE6");
    for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
         NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
      if (nlh->nlmsg_type == NLMSG_DONE) {
        done = 1;
        break;
      }
      require(nlh->nlmsg_type != NLMSG_ERROR, "RTM_GETROUTE6 error");
      if (nlh->nlmsg_type != RTM_NEWROUTE) {
        continue;
      }
      const struct rtmsg *rtm = (const struct rtmsg *)NLMSG_DATA(nlh);
      uint32_t table = rtm->rtm_table;
      uint32_t oif = 0;
      struct in6_addr dst_ip;
      int has_dst = 0;
      memset(&dst_ip, 0, sizeof(dst_ip));
      int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*rtm));
      for (const struct rtattr *rta =
               (const struct rtattr *)(((const char *)rtm) +
                                       NLMSG_ALIGN(sizeof(*rtm)));
           RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
        if (rta->rta_type == RTA_TABLE && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&table, RTA_DATA(rta), 4);
        } else if (rta->rta_type == RTA_OIF && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&oif, RTA_DATA(rta), 4);
        } else if (rta->rta_type == RTA_DST && RTA_PAYLOAD(rta) == 16) {
          memcpy(&dst_ip, RTA_DATA(rta), 16);
          has_dst = 1;
        }
      }
      if (has_dst && table == 201 && rtm->rtm_dst_len == 64 && oif == oif20 &&
          memcmp(&dst_ip, &dst1, 16) == 0) {
        found1 = 1;
      }
      if (has_dst && table == 202 && rtm->rtm_dst_len == 64 && oif == oif21 &&
          memcmp(&dst_ip, &dst2, 16) == 0) {
        found2 = 1;
      }
    }
  }
  require(found1 && found2, "IPv6 custom tables 201/202 readback");
}

int main(void) {
  int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
  require(nl_fd >= 0, "socket(AF_NETLINK)");

  set_iface_up("lo");
  create_dummy(nl_fd, "dummy20");
  create_dummy(nl_fd, "dummy21");

  set_iface_up("dummy20");
  set_iface_up("dummy21");

  uint32_t oif20 = if_nametoindex("dummy20");
  uint32_t oif21 = if_nametoindex("dummy21");
  require(oif20 != 0 && oif21 != 0, "dummy20/21 ifindex");

  add_ipv6_addr_nodad(nl_fd, oif20, "fd99:1::1");
  add_ipv6_addr_nodad(nl_fd, oif21, "fd99:2::1");

  route6_op(nl_fd, RTM_NEWROUTE,
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 201,
            "fd99:201::", 64, oif20);
  route6_op(nl_fd, RTM_NEWROUTE,
            NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 202,
            "fd99:202::", 64, oif21);

  rule6_op(nl_fd, RTM_NEWRULE,
           NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 2001, 201,
           "fd99:1::1");
  rule6_op(nl_fd, RTM_NEWRULE,
           NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 2002, 202,
           "fd99:2::1");

  verify_rules6_present(nl_fd, "fd99:1::1", "fd99:2::1");
  verify_routes6_present(nl_fd, oif20, oif21);

  int udp_fd = socket(AF_INET6, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(udp_fd >= 0, "socket(AF_INET6, SOCK_DGRAM)");

  struct sockaddr_in6 local_addr;
  memset(&local_addr, 0, sizeof(local_addr));
  local_addr.sin6_family = AF_INET6;
  require(inet_pton(AF_INET6, "fd99:1::1", &local_addr.sin6_addr) == 1,
          "inet_pton local6");
  require(bind(udp_fd, (const struct sockaddr *)&local_addr,
               sizeof(local_addr)) == 0,
          "bind fd99:1::1");

  struct sockaddr_in6 peer_addr;
  memset(&peer_addr, 0, sizeof(peer_addr));
  peer_addr.sin6_family = AF_INET6;
  peer_addr.sin6_port = htons(54321);
  require(inet_pton(AF_INET6, "fd99:2::1", &peer_addr.sin6_addr) == 1,
          "inet_pton peer6");
  require(connect(udp_fd, (const struct sockaddr *)&peer_addr,
                  sizeof(peer_addr)) == 0,
          "connect fd99:2::1");

  struct sockaddr_in6 bound_addr;
  socklen_t blen = sizeof(bound_addr);
  require(getsockname(udp_fd, (struct sockaddr *)&bound_addr, &blen) == 0,
          "getsockname6");
  require(memcmp(&bound_addr.sin6_addr, &local_addr.sin6_addr, 16) == 0,
          "getsockname fd99:1::1");
  require(close(udp_fd) == 0, "close udp_fd");

  rule6_op(nl_fd, RTM_DELRULE, NLM_F_REQUEST | NLM_F_ACK, 2001, 201,
           "fd99:1::1");
  rule6_op(nl_fd, RTM_DELRULE, NLM_F_REQUEST | NLM_F_ACK, 2002, 202,
           "fd99:2::1");
  route6_op(nl_fd, RTM_DELROUTE, NLM_F_REQUEST | NLM_F_ACK, 201, "fd99:201::",
            64, oif20);
  route6_op(nl_fd, RTM_DELROUTE, NLM_F_REQUEST | NLM_F_ACK, 202, "fd99:202::",
            64, oif21);
  delete_link_by_name(nl_fd, "dummy20");
  delete_link_by_name(nl_fd, "dummy21");
  require(close(nl_fd) == 0, "close nl_fd");

  printf("ipv6-policy-route-runtime: ok oif20=%u oif21=%u tables=201,202\n",
         oif20, oif21);
  return 0;
}
