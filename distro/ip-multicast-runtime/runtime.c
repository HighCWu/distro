#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
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

static uint16_t test_ipv6_multicast(void) {
  unsigned int lo_idx = if_nametoindex("lo");
  require(lo_idx != 0, "if_nametoindex(lo)");

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
  mreq6.ipv6mr_interface = lo_idx;
  require(setsockopt(rx_fd, IPPROTO_IPV6, IPV6_ADD_MEMBERSHIP, &mreq6,
                     sizeof(mreq6)) == 0,
          "IPV6_ADD_MEMBERSHIP");

  int tx_fd = socket(AF_INET6, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  require(tx_fd >= 0, "socket6 tx_fd");

  int ifidx = (int)lo_idx;
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
  return port;
}

int main(void) {
  bring_up_lo_multicast();
  uint16_t p4 = test_ipv4_multicast();
  uint16_t p6 = test_ipv6_multicast();

  printf("ip-multicast-runtime: ok p4=%u p6=%u\n", p4, p6);
  return 0;
}
