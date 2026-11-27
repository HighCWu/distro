#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
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
  fprintf(stderr, "ip-multipath-runtime: %s (errno=%d: %s)\n", what, errno,
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

static void add_multipath_route(int nl_fd, const char *dst_str, uint8_t dst_len,
                                uint32_t oif0, uint32_t oif1) {
  struct {
    struct nlmsghdr nlh;
    struct rtmsg rtm;
    char attrs[256];
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
  req.nlh.nlmsg_type = RTM_NEWROUTE;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
  req.rtm.rtm_family = AF_INET;
  req.rtm.rtm_dst_len = dst_len;
  req.rtm.rtm_table = RT_TABLE_MAIN;
  req.rtm.rtm_protocol = RTPROT_BOOT;
  req.rtm.rtm_scope = RT_SCOPE_LINK;
  req.rtm.rtm_type = RTN_UNICAST;

  struct in_addr dst;
  require(inet_pton(AF_INET, dst_str, &dst) == 1, "inet_pton dst");
  add_attr(&req.nlh, sizeof(req), RTA_DST, &dst, sizeof(dst));

  char mp_buf[64];
  memset(mp_buf, 0, sizeof(mp_buf));
  size_t hop_sz = RTNH_LENGTH(0);
  require(hop_sz * 2 <= sizeof(mp_buf), "mp_buf size");

  struct rtnexthop *nh0 = (struct rtnexthop *)mp_buf;
  nh0->rtnh_len = (unsigned short)hop_sz;
  nh0->rtnh_flags = 0;
  nh0->rtnh_hops = 0;
  nh0->rtnh_ifindex = (int)oif0;

  struct rtnexthop *nh1 = (struct rtnexthop *)(mp_buf + hop_sz);
  nh1->rtnh_len = (unsigned short)hop_sz;
  nh1->rtnh_flags = 0;
  nh1->rtnh_hops = 1;
  nh1->rtnh_ifindex = (int)oif1;

  add_attr(&req.nlh, sizeof(req), RTA_MULTIPATH, mp_buf, hop_sz * 2);
  send_and_expect_ack(nl_fd, &req.nlh, "RTM_NEWROUTE RTA_MULTIPATH");
}

static void delete_route(int nl_fd, const char *dst_str, uint8_t dst_len) {
  struct {
    struct nlmsghdr nlh;
    struct rtmsg rtm;
    char attrs[64];
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.rtm));
  req.nlh.nlmsg_type = RTM_DELROUTE;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
  req.rtm.rtm_family = AF_INET;
  req.rtm.rtm_dst_len = dst_len;
  req.rtm.rtm_table = RT_TABLE_MAIN;
  req.rtm.rtm_scope = RT_SCOPE_NOWHERE;

  struct in_addr dst;
  require(inet_pton(AF_INET, dst_str, &dst) == 1, "inet_pton del dst");
  add_attr(&req.nlh, sizeof(req), RTA_DST, &dst, sizeof(dst));
  send_and_expect_ack(nl_fd, &req.nlh, "RTM_DELROUTE");
}

static void verify_multipath_route(int nl_fd, const char *dst_str,
                                   uint8_t dst_len, uint32_t oif0,
                                   uint32_t oif1) {
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

  struct in_addr exp_dst;
  require(inet_pton(AF_INET, dst_str, &exp_dst) == 1, "inet_pton exp_dst");

  int found = 0;
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
      if (rtm->rtm_dst_len != dst_len || rtm->rtm_table != RT_TABLE_MAIN) {
        continue;
      }
      uint32_t dst_ip = 0;
      const struct rtattr *mp_attr = NULL;
      int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*rtm));
      for (const struct rtattr *rta =
               (const struct rtattr *)(((const char *)rtm) +
                                       NLMSG_ALIGN(sizeof(*rtm)));
           RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
        if (rta->rta_type == RTA_DST && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&dst_ip, RTA_DATA(rta), 4);
        } else if (rta->rta_type == RTA_MULTIPATH) {
          mp_attr = rta;
        }
      }
      if (dst_ip == exp_dst.s_addr && mp_attr != NULL) {
        int nh_len = (int)RTA_PAYLOAD(mp_attr);
        const struct rtnexthop *nh =
            (const struct rtnexthop *)RTA_DATA(mp_attr);
        int hops_seen = 0;
        int ok0 = 0;
        int ok1 = 0;
        while (RTNH_OK(nh, nh_len)) {
          if (hops_seen == 0 && nh->rtnh_ifindex == (int)oif0 &&
              nh->rtnh_hops == 0) {
            ok0 = 1;
          } else if (hops_seen == 1 && nh->rtnh_ifindex == (int)oif1 &&
                     nh->rtnh_hops == 1) {
            ok1 = 1;
          }
          hops_seen++;
          nh_len -= (int)RTNH_ALIGN(nh->rtnh_len);
          nh = RTNH_NEXT(nh);
        }
        require(hops_seen == 2 && ok0 && ok1, "RTA_MULTIPATH hops match");
        found = 1;
      }
    }
  }
  require(found, "multipath route found in RTM_GETROUTE");
}

int main(void) {
  int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
  require(nl_fd >= 0, "socket(AF_NETLINK)");

  set_iface_up_ipv4("lo", NULL, NULL);
  create_dummy(nl_fd, "dummy30");
  create_dummy(nl_fd, "dummy31");

  set_iface_up_ipv4("dummy30", "10.88.1.1", "255.255.255.0");
  set_iface_up_ipv4("dummy31", "10.88.2.1", "255.255.255.0");

  uint32_t oif30 = if_nametoindex("dummy30");
  uint32_t oif31 = if_nametoindex("dummy31");
  require(oif30 != 0 && oif31 != 0, "dummy30/31 ifindex");

  add_multipath_route(nl_fd, "10.88.100.0", 24, oif30, oif31);
  verify_multipath_route(nl_fd, "10.88.100.0", 24, oif30, oif31);

  delete_route(nl_fd, "10.88.100.0", 24);
  delete_link_by_name(nl_fd, "dummy30");
  delete_link_by_name(nl_fd, "dummy31");
  require(close(nl_fd) == 0, "close nl_fd");

  printf("ip-multipath-runtime: ok oif30=%u(w1) oif31=%u(w2)\n", oif30, oif31);
  return 0;
}
