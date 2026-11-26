// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

struct nexthop {
    struct rtnexthop hop;
    struct rtattr gateway;
    struct in_addr address;
};

struct route_request {
    struct nlmsghdr header;
    struct rtmsg route;
    struct rtattr destination;
    struct in_addr prefix;
    struct rtattr multipath;
    struct nexthop hops[2];
};

static void require(bool ok, const char *stage)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: IPv4 multipath: %s errno=%d\n", stage, errno);
    fflush(stderr);
    _Exit(1);
}

static void send_request(int fd, const struct nlmsghdr *header)
{
    const struct sockaddr_nl address = {.nl_family = AF_NETLINK};
    require(sendto(fd, header, header->nlmsg_len, 0, (const struct sockaddr *)&address,
                   sizeof(address)) == (ssize_t)header->nlmsg_len, "send netlink request");
}

static size_t receive(int fd, void *buffer, size_t capacity)
{
    const ssize_t bytes = recv(fd, buffer, capacity, 0);
    require(bytes >= (ssize_t)sizeof(struct nlmsghdr), "receive netlink response");
    return (size_t)bytes;
}

static void receive_ack(int fd, unsigned sequence, const char *stage)
{
    union { struct nlmsghdr header; unsigned char bytes[4096]; } response;
    const size_t bytes = receive(fd, response.bytes, sizeof(response.bytes));
    const struct nlmsghdr *header = &response.header;
    require(header->nlmsg_seq == sequence && header->nlmsg_type == NLMSG_ERROR &&
            header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct nlmsgerr)) &&
            header->nlmsg_len <= bytes, "validate route ACK");
    const struct nlmsgerr *status = NLMSG_DATA(header);
    errno = -status->error;
    require(status->error == 0, stage);
}

static bool is_destination(const struct rtattr *attr, struct in_addr prefix)
{
    struct in_addr value;
    if (attr->rta_type != RTA_DST || RTA_PAYLOAD(attr) != sizeof(value)) return false;
    memcpy(&value, RTA_DATA(attr), sizeof(value));
    return value.s_addr == prefix.s_addr;
}

static void verify_hops(const struct rtattr *attr, unsigned loopback)
{
    require(RTA_PAYLOAD(attr) == 2 * sizeof(struct nexthop), "read both nexthops");
    struct nexthop hops[2];
    memcpy(hops, RTA_DATA(attr), sizeof(hops));
    for (unsigned i = 0; i < 2; ++i) {
        require(hops[i].hop.rtnh_len == sizeof(struct nexthop) &&
                hops[i].hop.rtnh_ifindex == (int)loopback &&
                (hops[i].hop.rtnh_flags & RTNH_F_ONLINK) &&
                hops[i].hop.rtnh_hops == i, "preserve nexthop device, flags and weight");
        require(hops[i].gateway.rta_type == RTA_GATEWAY &&
                hops[i].gateway.rta_len == RTA_LENGTH(sizeof(struct in_addr)) &&
                hops[i].address.s_addr == htonl(UINT32_C(0xc0000201) + i), "preserve nexthop gateway");
    }
}

static bool route_in_dump(int fd, unsigned sequence, unsigned loopback, struct in_addr prefix)
{
    const struct { struct nlmsghdr header; struct rtmsg route; } request = {
        .header = {.nlmsg_len = sizeof(request), .nlmsg_type = RTM_GETROUTE,
                   .nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP, .nlmsg_seq = sequence},
        .route = {.rtm_family = AF_INET},
    };
    send_request(fd, &request.header);
    bool found = false;
    for (unsigned batch = 0; batch < 16; ++batch) {
        union { struct nlmsghdr header; unsigned char bytes[8192]; } response;
        int remaining = (int)receive(fd, response.bytes, sizeof(response.bytes));
        for (struct nlmsghdr *message = &response.header;
             remaining >= (int)sizeof(*message) && NLMSG_OK(message, (unsigned)remaining);
             message = NLMSG_NEXT(message, remaining)) {
            require(message->nlmsg_seq == sequence && !(message->nlmsg_flags & NLM_F_DUMP_INTR),
                    "route dump response sequence");
            if (message->nlmsg_type == NLMSG_DONE) {
                int status;
                require(message->nlmsg_len >= NLMSG_LENGTH(sizeof(status)), "read route dump status");
                memcpy(&status, NLMSG_DATA(message), sizeof(status));
                errno = -status;
                require(status == 0, "route dump completed");
                return found;
            }
            require(message->nlmsg_type == RTM_NEWROUTE && message->nlmsg_len >= NLMSG_LENGTH(sizeof(struct rtmsg)),
                    "route dump record");
            const struct rtmsg *route = NLMSG_DATA(message);
            if (route->rtm_family != AF_INET || route->rtm_dst_len != 24 ||
                route->rtm_table != RT_TABLE_MAIN) continue;
            int length = RTM_PAYLOAD(message);
            bool matches = false;
            const struct rtattr *multipath = NULL;
            for (const struct rtattr *attr = RTM_RTA(route); RTA_OK(attr, length);
                 attr = RTA_NEXT(attr, length)) {
                if (is_destination(attr, prefix)) matches = true;
                if (attr->rta_type == RTA_MULTIPATH) multipath = attr;
            }
            if (matches) {
                require(!found && multipath, "exact route has multipath attribute");
                verify_hops(multipath, loopback);
                found = true;
            }
        }
    }
    require(false, "dump did not terminate");
    return false;
}

int main(void)
{
    const int control = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    require(control >= 0, "open loopback control socket");
    struct ifreq loopback = {.ifr_name = "lo"};
    require(ioctl(control, SIOCGIFFLAGS, &loopback) == 0, "read loopback flags");
    const short initial_flags = loopback.ifr_flags;
    if (!(initial_flags & IFF_UP)) {
        loopback.ifr_flags |= IFF_UP;
        require(ioctl(control, SIOCSIFFLAGS, &loopback) == 0, "enable loopback");
    }
    const unsigned index = if_nametoindex("lo");
    require(index > 0, "resolve loopback index");

    const int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    require(fd >= 0, "open rtnetlink socket");
    const struct timeval timeout = {.tv_sec = 3};
    require(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0, "bound netlink receive");
    const struct sockaddr_nl address = {.nl_family = AF_NETLINK};
    require(bind(fd, (const struct sockaddr *)&address, sizeof(address)) == 0, "bind rtnetlink socket");

    struct route_request request = {
        .header = {.nlmsg_len = sizeof(request), .nlmsg_type = RTM_NEWROUTE,
                   .nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK | NLM_F_CREATE | NLM_F_EXCL, .nlmsg_seq = 1},
        .route = {.rtm_family = AF_INET, .rtm_dst_len = 24, .rtm_table = RT_TABLE_MAIN,
                  .rtm_protocol = RTPROT_STATIC, .rtm_scope = RT_SCOPE_UNIVERSE, .rtm_type = RTN_UNICAST},
        .destination = {.rta_len = RTA_LENGTH(sizeof(struct in_addr)), .rta_type = RTA_DST},
        .prefix = {.s_addr = htonl(UINT32_C(0xc6120000))},
        .multipath = {.rta_len = RTA_LENGTH(2 * sizeof(struct nexthop)), .rta_type = RTA_MULTIPATH},
    };
    for (unsigned i = 0; i < 2; ++i) {
        request.hops[i] = (struct nexthop){
            .hop = {.rtnh_len = sizeof(struct nexthop), .rtnh_flags = RTNH_F_ONLINK,
                    .rtnh_hops = i, .rtnh_ifindex = (int)index},
            .gateway = {.rta_len = RTA_LENGTH(sizeof(struct in_addr)), .rta_type = RTA_GATEWAY},
            .address = {.s_addr = htonl(UINT32_C(0xc0000201) + i)},
        };
    }
    send_request(fd, &request.header);
    receive_ack(fd, 1, "add IPv4 route with two weighted nexthops");
    require(route_in_dump(fd, 2, index, request.prefix), "find IPv4 multipath route");
    puts("IPv4 multipath: both weighted nexthops returned");
    request.header.nlmsg_len -= request.multipath.rta_len;
    request.header.nlmsg_type = RTM_DELROUTE;
    request.header.nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK;
    request.header.nlmsg_seq = 3;
    send_request(fd, &request.header);
    receive_ack(fd, 3, "delete IPv4 multipath route");
    require(!route_in_dump(fd, 4, index, request.prefix), "route absent after deletion");
    require(close(fd) == 0, "close rtnetlink socket");
    if (!(initial_flags & IFF_UP)) {
        loopback.ifr_flags = initial_flags;
        require(ioctl(control, SIOCSIFFLAGS, &loopback) == 0, "restore loopback flags");
    }
    require(close(control) == 0, "close loopback control socket");
    puts("IPv4 multipath: route removed and fixture closed");
#ifdef __wasm__
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) pause();
#endif
}
