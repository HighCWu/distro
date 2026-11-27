#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/if_addr.h>
#include <linux/if_link.h>
#include <linux/neighbour.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static uint32_t next_seq = 1;

static void require(int ok, const char *what) {
  if (ok) {
    return;
  }
  fprintf(stderr, "netlink-route-attr-runtime: %s (errno=%d: %s)\n", what,
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

static int send_and_get_ack_err(int fd, struct nlmsghdr *nlh,
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
  return err->error;
}

static void send_and_expect_ack(int fd, struct nlmsghdr *nlh,
                                const char *what) {
  int err = send_and_get_ack_err(fd, nlh, what);
  if (err != 0) {
    errno = -err;
    require(0, what);
  }
}

static void verify_link_attrs(int nl_fd, uint32_t ifindex, uint32_t exp_mtu,
                              const char *exp_alias) {
  struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.ifi));
  req.nlh.nlmsg_type = RTM_GETLINK;
  req.nlh.nlmsg_flags = NLM_F_REQUEST;
  req.nlh.nlmsg_seq = next_seq++;
  req.ifi.ifi_family = AF_UNSPEC;
  req.ifi.ifi_index = (int)ifindex;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto RTM_GETLINK");

  char buf[4096];
  ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
  require(n >= (ssize_t)sizeof(struct nlmsghdr), "recv RTM_GETLINK");
  const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
  require(NLMSG_OK(nlh, (size_t)n) && nlh->nlmsg_type == RTM_NEWLINK,
          "RTM_NEWLINK reply");

  const struct ifinfomsg *ifi = (const struct ifinfomsg *)NLMSG_DATA(nlh);
  uint32_t mtu = 0;
  char alias[64];
  memset(alias, 0, sizeof(alias));
  int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*ifi));
  for (const struct rtattr *rta =
           (const struct rtattr *)(((const char *)ifi) +
                                   NLMSG_ALIGN(sizeof(*ifi)));
       RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
    if (rta->rta_type == IFLA_MTU && RTA_PAYLOAD(rta) >= 4) {
      memcpy(&mtu, RTA_DATA(rta), 4);
    } else if (rta->rta_type == IFLA_IFALIAS && RTA_PAYLOAD(rta) > 0) {
      size_t cp = RTA_PAYLOAD(rta);
      if (cp >= sizeof(alias)) {
        cp = sizeof(alias) - 1;
      }
      memcpy(alias, RTA_DATA(rta), cp);
    }
  }
  require(mtu == exp_mtu, "IFLA_MTU readback");
  if (exp_alias != NULL) {
    require(strcmp(alias, exp_alias) == 0, "IFLA_IFALIAS readback");
  }
}

static void verify_neigh_present(int nl_fd, uint32_t ifindex,
                                 const char *dst_str, const uint8_t *mac) {
  struct {
    struct nlmsghdr nlh;
    struct ndmsg ndm;
  } req;
  memset(&req, 0, sizeof(req));
  req.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(req.ndm));
  req.nlh.nlmsg_type = RTM_GETNEIGH;
  req.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
  req.nlh.nlmsg_seq = next_seq++;
  req.ndm.ndm_family = AF_INET;

  struct sockaddr_nl kernel;
  memset(&kernel, 0, sizeof(kernel));
  kernel.nl_family = AF_NETLINK;
  require(sendto(nl_fd, &req, req.nlh.nlmsg_len, 0,
                 (const struct sockaddr *)&kernel,
                 sizeof(kernel)) == (ssize_t)req.nlh.nlmsg_len,
          "sendto RTM_GETNEIGH");

  struct in_addr exp_dst;
  require(inet_pton(AF_INET, dst_str, &exp_dst) == 1, "inet_pton exp_dst");

  int found = 0;
  int done = 0;
  char buf[8192];
  while (!done) {
    ssize_t n = recv(nl_fd, buf, sizeof(buf), 0);
    require(n > 0, "recv RTM_GETNEIGH");
    for (const struct nlmsghdr *nlh = (const struct nlmsghdr *)buf;
         NLMSG_OK(nlh, (size_t)n); nlh = NLMSG_NEXT(nlh, n)) {
      if (nlh->nlmsg_type == NLMSG_DONE) {
        done = 1;
        break;
      }
      require(nlh->nlmsg_type != NLMSG_ERROR, "RTM_GETNEIGH error");
      if (nlh->nlmsg_type != RTM_NEWNEIGH) {
        continue;
      }
      const struct ndmsg *ndm = (const struct ndmsg *)NLMSG_DATA(nlh);
      if (ndm->ndm_ifindex != (int)ifindex) {
        continue;
      }
      uint32_t dst_ip = 0;
      uint8_t lladdr[6];
      int has_ll = 0;
      memset(lladdr, 0, sizeof(lladdr));
      int attrlen = (int)nlh->nlmsg_len - (int)NLMSG_LENGTH(sizeof(*ndm));
      for (const struct rtattr *rta =
               (const struct rtattr *)(((const char *)ndm) +
                                       NLMSG_ALIGN(sizeof(*ndm)));
           RTA_OK(rta, attrlen); rta = RTA_NEXT(rta, attrlen)) {
        if (rta->rta_type == NDA_DST && RTA_PAYLOAD(rta) >= 4) {
          memcpy(&dst_ip, RTA_DATA(rta), 4);
        } else if (rta->rta_type == NDA_LLADDR && RTA_PAYLOAD(rta) == 6) {
          memcpy(lladdr, RTA_DATA(rta), 6);
          has_ll = 1;
        }
      }
      if (dst_ip == exp_dst.s_addr && has_ll && memcmp(lladdr, mac, 6) == 0 &&
          (ndm->ndm_state & NUD_PERMANENT) != 0) {
        found = 1;
      }
    }
  }
  require(found, "RTM_GETNEIGH entry found");
}

int main(void) {
  int nl_fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
  require(nl_fd >= 0, "socket(AF_NETLINK)");

  int one = 1;
  require(setsockopt(nl_fd, SOL_NETLINK, NETLINK_EXT_ACK, &one, sizeof(one)) ==
              0,
          "NETLINK_EXT_ACK");
  require(setsockopt(nl_fd, SOL_NETLINK, NETLINK_CAP_ACK, &one, sizeof(one)) ==
              0,
          "NETLINK_CAP_ACK");

  struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
    char attrs[256];
  } lreq;
  memset(&lreq, 0, sizeof(lreq));
  lreq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(lreq.ifi));
  lreq.nlh.nlmsg_type = RTM_NEWLINK;
  lreq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
  lreq.ifi.ifi_family = AF_UNSPEC;

  add_attr(&lreq.nlh, sizeof(lreq), IFLA_IFNAME, "dummy40", sizeof("dummy40"));
  uint32_t mtu1 = 1400U;
  add_attr(&lreq.nlh, sizeof(lreq), IFLA_MTU, &mtu1, sizeof(mtu1));
  struct rtattr *li = nest_begin(&lreq.nlh, sizeof(lreq), IFLA_LINKINFO);
  add_attr(&lreq.nlh, sizeof(lreq), IFLA_INFO_KIND, "dummy", sizeof("dummy") - 1);
  nest_end(&lreq.nlh, li);
  send_and_expect_ack(nl_fd, &lreq.nlh, "RTM_NEWLINK dummy40");

  uint32_t oif40 = if_nametoindex("dummy40");
  require(oif40 != 0, "if_nametoindex(dummy40)");
  verify_link_attrs(nl_fd, oif40, 1400U, NULL);

  memset(&lreq, 0, sizeof(lreq));
  lreq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(lreq.ifi));
  lreq.nlh.nlmsg_type = RTM_SETLINK;
  lreq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
  lreq.ifi.ifi_family = AF_UNSPEC;
  lreq.ifi.ifi_index = (int)oif40;
  lreq.ifi.ifi_flags = IFF_UP;
  lreq.ifi.ifi_change = IFF_UP;
  uint32_t mtu2 = 1440U;
  add_attr(&lreq.nlh, sizeof(lreq), IFLA_MTU, &mtu2, sizeof(mtu2));
  const char alias[] = "wasm-nl-attr";
  add_attr(&lreq.nlh, sizeof(lreq), IFLA_IFALIAS, alias, sizeof(alias) - 1);
  send_and_expect_ack(nl_fd, &lreq.nlh, "RTM_SETLINK dummy40");
  verify_link_attrs(nl_fd, oif40, 1440U, "wasm-nl-attr");

  struct {
    struct nlmsghdr nlh;
    struct ifaddrmsg ifa;
    char attrs[128];
  } areq;
  memset(&areq, 0, sizeof(areq));
  areq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(areq.ifa));
  areq.nlh.nlmsg_type = RTM_NEWADDR;
  areq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
  areq.ifa.ifa_family = AF_INET;
  areq.ifa.ifa_prefixlen = 24;
  areq.ifa.ifa_scope = RT_SCOPE_UNIVERSE;
  areq.ifa.ifa_index = oif40;
  struct in_addr addr4;
  require(inet_pton(AF_INET, "10.78.0.1", &addr4) == 1, "inet_pton addr4");
  add_attr(&areq.nlh, sizeof(areq), IFA_LOCAL, &addr4, sizeof(addr4));
  add_attr(&areq.nlh, sizeof(areq), IFA_LABEL, "dummy40:nl",
           sizeof("dummy40:nl"));
  send_and_expect_ack(nl_fd, &areq.nlh, "RTM_NEWADDR dummy40");

  struct {
    struct nlmsghdr nlh;
    struct ndmsg ndm;
    char attrs[128];
  } nreq;
  memset(&nreq, 0, sizeof(nreq));
  nreq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(nreq.ndm));
  nreq.nlh.nlmsg_type = RTM_NEWNEIGH;
  nreq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL;
  nreq.ndm.ndm_family = AF_INET;
  nreq.ndm.ndm_ifindex = (int)oif40;
  nreq.ndm.ndm_state = NUD_PERMANENT;
  nreq.ndm.ndm_type = RTN_UNICAST;
  struct in_addr ndst;
  require(inet_pton(AF_INET, "10.78.0.2", &ndst) == 1, "inet_pton ndst");
  const uint8_t mac[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x55};
  add_attr(&nreq.nlh, sizeof(nreq), NDA_DST, &ndst, sizeof(ndst));
  add_attr(&nreq.nlh, sizeof(nreq), NDA_LLADDR, mac, sizeof(mac));
  send_and_expect_ack(nl_fd, &nreq.nlh, "RTM_NEWNEIGH");

  verify_neigh_present(nl_fd, oif40, "10.78.0.2", mac);

  memset(&nreq, 0, sizeof(nreq));
  nreq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(nreq.ndm));
  nreq.nlh.nlmsg_type = RTM_DELNEIGH;
  nreq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
  nreq.ndm.ndm_family = AF_INET;
  nreq.ndm.ndm_ifindex = (int)oif40;
  add_attr(&nreq.nlh, sizeof(nreq), NDA_DST, &ndst, sizeof(ndst));
  send_and_expect_ack(nl_fd, &nreq.nlh, "RTM_DELNEIGH");

  struct {
    struct nlmsghdr nlh;
    struct ifinfomsg ifi;
  } dreq;
  memset(&dreq, 0, sizeof(dreq));
  dreq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(dreq.ifi));
  dreq.nlh.nlmsg_type = RTM_DELLINK;
  dreq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
  dreq.ifi.ifi_family = AF_UNSPEC;
  dreq.ifi.ifi_index = 999999;
  require(send_and_get_ack_err(nl_fd, &dreq.nlh, "RTM_DELLINK ENODEV") ==
              -ENODEV,
          "RTM_DELLINK nonexistent ENODEV");

  memset(&dreq, 0, sizeof(dreq));
  dreq.nlh.nlmsg_len = NLMSG_LENGTH(sizeof(dreq.ifi));
  dreq.nlh.nlmsg_type = RTM_DELLINK;
  dreq.nlh.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
  dreq.ifi.ifi_family = AF_UNSPEC;
  dreq.ifi.ifi_index = (int)oif40;
  send_and_expect_ack(nl_fd, &dreq.nlh, "RTM_DELLINK dummy40");

  require(close(nl_fd) == 0, "close nl_fd");
  printf("netlink-route-attr-runtime: ok oif=%u mtu=%u\n", oif40, mtu2);
  return 0;
}
