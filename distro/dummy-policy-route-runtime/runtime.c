#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/fib_rules.h>
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
  fprintf(stderr, "dummy-policy-route-runtime: %s (errno=%d: %s)\n", what,
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

static void route_op(int nl_fd, uint16_t type, uint16_t flags, uint32_t table,
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
  req.rtm.rtm_family = AF_INET;
  req.rtm.rtm_dst_len = dst_len;
  req.rtm.rtm_table = RT_TABLE_UNSPEC;
  req.rtm.rtm_protocol = RTPROT_BOOT;
  req.rtm.rtm_scope = RT_SCOPE_LINK;
  req.rtm.rtm_type = RTN_UNICAST;

  struct in_addr dst;
  require(inet_pton(AF_INET, dst_str, &dst) == 1, "inet_pton dst");
  add_attr(&req.nlh, sizeof(req), RTA_DST, &dst, sizeof(dst));
  add_attr(&req.nlh, sizeof(req), RTA_TABLE, &table, sizeof(table));
  add_attr(&req.nlh, sizeof(req), RTA_OIF, &oif, sizeof(oif));

  send_and_expect_ack(nl_fd, &req.nlh,
                      type == RTM_NEWROUTE ? "RTM_NEWROUTE" : "RTM_DELROUTE");
}

static void rule_op(int nl_fd, uint16_t type, uint16_t flags, uint32_t prio,
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
  req.frh.family = AF_INET;
  req.frh.src_len = 32;
  req.frh.table = RT_TABLE_UNSPEC;
  req.frh.action = FR_ACT_TO_TBL;

  struct in_addr src;
  require(inet_pton(AF_INET, src_str, &src) == 1, "inet_pton src");
  add_attr(&req.nlh, sizeof(req), FRA_SRC, &src, sizeof(src));
  add_attr(&req.nlh, sizeof(req), FRA_PRIORITY, &prio, sizeof(prio));
  add_attr(&req.nlh, sizeof(req), FRA_TABLE, &table, sizeof(table));

  send_and_expect_ack(nl_fd, &req.nlh,
                      type == RTM_NEWRULE ? "RTM_NEWRULE" : "RTM_DELRULE");
}

static void verify_rules_present(int nl_fd, const char *src1, const char *src2) {
  struct {
    struct nlmsghdr nlh;
    struct fib_rule_hdr frh;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.frh));
  req.nlh.nlmsg_type = RTM_GETRULE;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  req.nlh.nlmsg_seq = next_seq++;
  req.frh.family = AF_INET;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto RTM_GETRULE");

  struct in_addr exp1, exp2;
  require(inet_pton(AF_INET, src1, &exp1) == 1, "inet_pton exp1");
  require(inet_pton(AF_INET, src2, &exp2) == 1, "inet_pton exp2");

  int found1 = 0;
  int found2 = 0;
  int done = 0;
  char buf[8192];
  while (!done) {
    ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
    require(n > 0, "recv RTM_GETRULE");
    for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
         NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
      if (nlh->nlmsg_type == NLMSG_DONE) {
        done = 1;
        break;
      }
      require(nlh->nlmsg_type != NLMSG_ERROR, "RTM_GETRULE error");
      if (nlh->nlmsg_type != RTM_NEWRULE) {
        continue;
      }
      const struct fib_rule_hdr *frh =
          (const struct fib_rule_hdr *)NLMSG_DATA(nlh);
      uint32_t prio = 0;
      uint32_t table = frh->table;
      uint32_t src_ip = 0;
      int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*frh));
      for (const struct rtattr *rta =
               (const struct rtattr *)(((const char *)frh) +
                                       NLMSG_ALIGN(sizeof(*frh)));
           RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
        if (rta->rta_type == FRA_PRIORITY && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&prio, RTA_DATA(rta), 4);
        } else if (rta->rta_type == FRA_TABLE && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&table, RTA_DATA(rta), 4);
        } else if (rta->rta_type == FRA_SRC && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&src_ip, RTA_DATA(rta), 4);
        }
      }
      if (prio == 1001 && table == 101 && src_ip == exp1.s_addr) {
        found1 = 1;
      }
      if (prio == 1002 && table == 102 && src_ip == exp2.s_addr) {
        found2 = 1;
      }
    }
  }
  require(found1 && found2, "policy rules 1001/1002 readback");
}

static void verify_routes_present(int nl_fd, uint32_t oif0, uint32_t oif1) {
  struct {
    struct nlmsghdr nlh;
    struct rtmsg rtm;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
  req.nlh.nlmsg_type = RTM_GETROUTE;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  req.nlh.nlmsg_seq = next_seq++;
  req.rtm.rtm_family = AF_INET;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto RTM_GETROUTE");

  struct in_addr dst1, dst2;
  require(inet_pton(AF_INET, "10.99.101.0", &dst1) == 1, "inet_pton dst1");
  require(inet_pton(AF_INET, "10.99.102.0", &dst2) == 1, "inet_pton dst2");

  int found1 = 0;
  int found2 = 0;
  int done = 0;
  char buf[8192];
  while (!done) {
    ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
    require(n > 0, "recv RTM_GETROUTE");
    for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
         NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
      if (nlh->nlmsg_type == NLMSG_DONE) {
        done = 1;
        break;
      }
      require(nlh->nlmsg_type != NLMSG_ERROR, "RTM_GETROUTE error");
      if (nlh->nlmsg_type != RTM_NEWROUTE) {
        continue;
      }
      const struct rtmsg *rtm = (const struct rtmsg *)NLMSG_DATA(nlh);
      uint32_t table = rtm->rtm_table;
      uint32_t oif = 0;
      uint32_t dst_ip = 0;
      int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*rtm));
      for (const struct rtattr *rta =
               (const struct rtattr *)(((const char *)rtm) +
                                       NLMSG_ALIGN(sizeof(*rtm)));
           RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
        if (rta->rta_type == RTA_TABLE && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&table, RTA_DATA(rta), 4);
        } else if (rta->rta_type == RTA_OIF && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&oif, RTA_DATA(rta), 4);
        } else if (rta->rta_type == RTA_DST && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&dst_ip, RTA_DATA(rta), 4);
        }
      }
      if (table == 101 && rtm->rtm_dst_len == 24 && oif == oif0 &&
          dst_ip == dst1.s_addr) {
        found1 = 1;
      }
      if (table == 102 && rtm->rtm_dst_len == 24 && oif == oif1 &&
          dst_ip == dst2.s_addr) {
        found2 = 1;
      }
    }
  }
  require(found1 && found2, "custom tables 101/102 readback");
}

int main(void) {
  int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
  require(nl_fd >= 0, "socket(AF_NETLINK)");

  set_iface_up_ipv4("lo", NULL, NULL);
  create_dummy(nl_fd, "dummy10");
  create_dummy(nl_fd, "dummy11");

  set_iface_up_ipv4("dummy10", "10.99.1.1", "255.255.255.0");
  set_iface_up_ipv4("dummy11", "10.99.2.1", "255.255.255.0");

  uint32_t oif0 = if_nametoindex("dummy10");
  uint32_t oif1 = if_nametoindex("dummy11");
  require(oif0 != 0 && oif1 != 0, "dummy ifindex");

  route_op(nl_fd, RTM_NEWROUTE,
           NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 101,
           "10.99.101.0", 24, oif0);
  route_op(nl_fd, RTM_NEWROUTE,
           NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 102,
           "10.99.102.0", 24, oif1);

  rule_op(nl_fd, RTM_NEWRULE,
          NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 1001, 101,
          "10.99.1.1");
  rule_op(nl_fd, RTM_NEWRULE,
          NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, 1002, 102,
          "10.99.2.1");

  verify_rules_present(nl_fd, "10.99.1.1", "10.99.2.1");
  verify_routes_present(nl_fd, oif0, oif1);

  int udp_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(udp_fd >= 0, "socket(AF_INET, SOCK_DGRAM)");

  struct sockaddr_in local_addr;
  memset(&local_addr, 0, sizeof(local_addr));
  local_addr.sin_family = AF_INET;
  require(inet_pton(AF_INET, "10.99.1.1", &local_addr.sin_addr) == 1,
          "inet_pton local");
  require(bind(udp_fd, (const struct sockaddr *)&local_addr,
               sizeof(local_addr)) == 0,
          "bind 10.99.1.1");

  struct sockaddr_in peer_addr;
  memset(&peer_addr, 0, sizeof(peer_addr));
  peer_addr.sin_family = AF_INET;
  peer_addr.sin_port = htons(54321);
  require(inet_pton(AF_INET, "10.99.2.1", &peer_addr.sin_addr) == 1,
          "inet_pton peer");
  require(connect(udp_fd, (const struct sockaddr *)&peer_addr,
                  sizeof(peer_addr)) == 0,
          "connect 10.99.2.1");

  struct sockaddr_in bound_addr;
  socklen_t blen = sizeof(bound_addr);
  require(getsockname(udp_fd, (struct sockaddr *)&bound_addr, &blen) == 0,
          "getsockname");
  require(bound_addr.sin_addr.s_addr == local_addr.sin_addr.s_addr,
          "getsockname 10.99.1.1");
  require(close(udp_fd) == 0, "close udp_fd");

  rule_op(nl_fd, RTM_DELRULE, NLM_F_REQUEST | NLM_F_ACK, 1001, 101,
          "10.99.1.1");
  rule_op(nl_fd, RTM_DELRULE, NLM_F_REQUEST | NLM_F_ACK, 1002, 102,
          "10.99.2.1");
  route_op(nl_fd, RTM_DELROUTE, NLM_F_REQUEST | NLM_F_ACK, 101, "10.99.101.0",
           24, oif0);
  route_op(nl_fd, RTM_DELROUTE, NLM_F_REQUEST | NLM_F_ACK, 102, "10.99.102.0",
           24, oif1);
  delete_link_by_name(nl_fd, "dummy10");
  delete_link_by_name(nl_fd, "dummy11");
  require(close(nl_fd) == 0, "close nl_fd");

  printf("dummy-policy-route-runtime: ok oif0=%u oif1=%u tables=101,102\n",
         oif0, oif1);
  return 0;
}
