// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/if_addr.h>
#include <linux/rtnetlink.h>
#include <net/if.h>
#include <netinet/in.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/uio.h>
#include <unistd.h>

struct address_request {
    struct nlmsghdr header;
    struct ifaddrmsg address;
    struct rtattr attribute;
    struct in6_addr value;
};

struct route_request {
    struct nlmsghdr header;
    struct rtmsg route;
    struct rtattr destination_attribute;
    struct in6_addr destination;
    struct rtattr source_attribute;
    struct in6_addr source;
    struct rtattr output_attribute;
    uint32_t output_index;
};

struct route_query {
    struct nlmsghdr header;
    struct rtmsg route;
    struct rtattr destination_attribute;
    struct in6_addr destination;
    struct rtattr source_attribute;
    struct in6_addr source;
};

struct route_result {
    unsigned char Type;
    uint32_t OutputIndex;
};

union netlink_response {
    struct nlmsghdr header;
    unsigned char bytes[4096];
};

_Static_assert(offsetof(struct address_request, attribute) == NLMSG_LENGTH(sizeof(struct ifaddrmsg)),
               "address attribute follows ifaddrmsg");
_Static_assert(offsetof(struct address_request, value) == offsetof(struct address_request, attribute) + sizeof(struct rtattr),
               "address payload immediately follows attribute");
_Static_assert(sizeof(struct address_request) ==
               NLMSG_LENGTH(sizeof(struct ifaddrmsg)) + RTA_LENGTH(sizeof(struct in6_addr)),
               "address request has no implicit padding");
_Static_assert(offsetof(struct route_request, destination_attribute) == NLMSG_LENGTH(sizeof(struct rtmsg)),
               "destination follows rtmsg");
_Static_assert(offsetof(struct route_request, source_attribute) ==
               offsetof(struct route_request, destination_attribute) + RTA_LENGTH(sizeof(struct in6_addr)),
               "source follows destination attribute");
_Static_assert(offsetof(struct route_request, output_attribute) ==
               offsetof(struct route_request, source_attribute) + RTA_LENGTH(sizeof(struct in6_addr)),
               "output follows source attribute");
_Static_assert(sizeof(struct route_request) ==
               offsetof(struct route_request, output_attribute) + RTA_LENGTH(sizeof(uint32_t)),
               "route request has no implicit padding");
_Static_assert(sizeof(struct route_query) ==
               offsetof(struct route_query, source_attribute) + RTA_LENGTH(sizeof(struct in6_addr)),
               "query request has no implicit padding");

static void require(bool ok, const char *stage)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: IPv6 source route: %s errno=%d\n", stage, errno);
    fflush(stderr);
    _Exit(1);
}

static unsigned next_sequence = 1;

static unsigned allocate_sequence(void)
{
    return next_sequence++;
}

static void send_request(int fd, const struct nlmsghdr *request, const char *stage)
{
    const struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
    ssize_t result;
    do {
        result = sendto(fd, request, request->nlmsg_len, 0,
                        (const struct sockaddr *)&kernel, sizeof(kernel));
    } while (result < 0 && errno == EINTR);
    require(result == (ssize_t)request->nlmsg_len, stage);
}

static struct nlmsghdr *receive_response(int fd, unsigned sequence,
                                         union netlink_response *response,
                                         const char *stage)
{
    struct sockaddr_nl sender = {0};
    struct iovec vector = {.iov_base = response->bytes, .iov_len = sizeof(response->bytes)};
    struct msghdr message = {
        .msg_name = &sender,
        .msg_namelen = sizeof(sender),
        .msg_iov = &vector,
        .msg_iovlen = 1,
    };
    ssize_t bytes;
    do {
        bytes = recvmsg(fd, &message, 0);
    } while (bytes < 0 && errno == EINTR);
    require(bytes >= (ssize_t)sizeof(struct nlmsghdr) && !(message.msg_flags & MSG_TRUNC) &&
            sender.nl_family == AF_NETLINK && sender.nl_pid == 0,
            stage);
    struct nlmsghdr *header = &response->header;
    require(header->nlmsg_len >= sizeof(*header) && header->nlmsg_len <= (size_t)bytes &&
            header->nlmsg_seq == sequence,
            "validate rtnetlink response header");
    return header;
}

static void exchange(int fd, struct nlmsghdr *request,
                     union netlink_response *response, const char *stage)
{
    request->nlmsg_seq = allocate_sequence();
    send_request(fd, request, stage);
    (void)receive_response(fd, request->nlmsg_seq, response, stage);
}

static void receive_ack(int fd, struct nlmsghdr *request, const char *stage)
{
    union netlink_response response;
    exchange(fd, request, &response, stage);
    struct nlmsghdr *header = &response.header;
    require(header->nlmsg_type == NLMSG_ERROR &&
            header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct nlmsgerr)),
            "validate rtnetlink ACK");
    const struct nlmsgerr *status = NLMSG_DATA(header);
    if (status->error < 0) errno = -status->error;
    require(status->error == 0, stage);
}

static struct in6_addr ipv6(const char *text)
{
    struct in6_addr address;
    require(inet_pton(AF_INET6, text, &address) == 1, "parse IPv6 fixture address");
    return address;
}

static void set_address(int fd, unsigned interface_index, struct in6_addr value,
                        bool add)
{
    struct address_request request = {
        .header = {
            .nlmsg_len = sizeof(request),
            .nlmsg_type = add ? RTM_NEWADDR : RTM_DELADDR,
            .nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK |
                (add ? NLM_F_CREATE | NLM_F_EXCL : 0),
        },
        .address = {
            .ifa_family = AF_INET6,
            .ifa_prefixlen = 128,
            .ifa_flags = add ? IFA_F_NODAD : 0,
            .ifa_scope = RT_SCOPE_UNIVERSE,
            .ifa_index = interface_index,
        },
        .attribute = {
            .rta_len = RTA_LENGTH(sizeof(value)),
            .rta_type = IFA_ADDRESS,
        },
        .value = value,
    };
    receive_ack(fd, &request.header, add ? "add IPv6 host address without DAD" : "delete IPv6 host address");
}

static struct route_request route_message(unsigned interface_index,
                                          struct in6_addr destination,
                                          struct in6_addr source,
                                          bool add)
{
    return (struct route_request){
        .header = {
            .nlmsg_len = sizeof(struct route_request),
            .nlmsg_type = add ? RTM_NEWROUTE : RTM_DELROUTE,
            .nlmsg_flags = NLM_F_REQUEST | NLM_F_ACK |
                (add ? NLM_F_CREATE | NLM_F_EXCL : 0),
        },
        .route = {
            .rtm_family = AF_INET6,
            .rtm_dst_len = 64,
            .rtm_src_len = 64,
            .rtm_table = RT_TABLE_MAIN,
            .rtm_protocol = RTPROT_STATIC,
            .rtm_scope = RT_SCOPE_UNIVERSE,
            .rtm_type = RTN_UNICAST,
        },
        .destination_attribute = {
            .rta_len = RTA_LENGTH(sizeof(destination)),
            .rta_type = RTA_DST,
        },
        .destination = destination,
        .source_attribute = {
            .rta_len = RTA_LENGTH(sizeof(source)),
            .rta_type = RTA_SRC,
        },
        .source = source,
        .output_attribute = {
            .rta_len = RTA_LENGTH(sizeof(uint32_t)),
            .rta_type = RTA_OIF,
        },
        .output_index = interface_index,
    };
}

static int lookup_route(int fd, struct in6_addr destination,
                        struct in6_addr source, struct route_result *result)
{
    struct route_query request = {
        .header = {
            .nlmsg_len = sizeof(request),
            .nlmsg_type = RTM_GETROUTE,
            .nlmsg_flags = NLM_F_REQUEST,
        },
        .route = {
            .rtm_family = AF_INET6,
            .rtm_dst_len = 128,
            .rtm_src_len = 128,
        },
        .destination_attribute = {
            .rta_len = RTA_LENGTH(sizeof(destination)),
            .rta_type = RTA_DST,
        },
        .destination = destination,
        .source_attribute = {
            .rta_len = RTA_LENGTH(sizeof(source)),
            .rta_type = RTA_SRC,
        },
        .source = source,
    };
    union netlink_response response;
    exchange(fd, &request.header, &response, "query IPv6 route");
    struct nlmsghdr *header = &response.header;
    if (header->nlmsg_type == NLMSG_ERROR) {
        require(header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct nlmsgerr)),
                "validate failed route query");
        const struct nlmsgerr *status = NLMSG_DATA(header);
        require(status->error < 0, "route query returned a real error");
        errno = -status->error;
        return -1;
    }
    require(header->nlmsg_type == RTM_NEWROUTE &&
            header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct rtmsg)),
            "validate successful route query");
    const struct rtmsg *route = NLMSG_DATA(header);
    require(route->rtm_family == AF_INET6, "route query returned IPv6 family");
    result->Type = route->rtm_type;
    result->OutputIndex = 0;
    int remaining = RTM_PAYLOAD(header);
    for (const struct rtattr *attribute = RTM_RTA(route); RTA_OK(attribute, remaining);
         attribute = RTA_NEXT(attribute, remaining)) {
        if (attribute->rta_type == RTA_OIF) {
            require(RTA_PAYLOAD(attribute) == sizeof(result->OutputIndex) && result->OutputIndex == 0,
                    "validate route output interface attribute");
            memcpy(&result->OutputIndex, RTA_DATA(attribute), sizeof(result->OutputIndex));
        }
    }
    require(remaining == 0, "parse complete route query attributes");
    return 0;
}

int main(void)
{
#ifdef __wasm__
    require(getpid() == 1, "run as init in isolated VM");
#endif
    require(getuid() == 0 && geteuid() == 0, "run as isolated root");
    const int control = socket(AF_INET6, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    require(control >= 0, "open loopback control socket");
    struct ifreq loopback = {.ifr_name = "lo"};
    require(ioctl(control, SIOCGIFFLAGS, &loopback) == 0, "read loopback flags");
    const short original_flags = loopback.ifr_flags;
    if (!(original_flags & IFF_UP)) {
        loopback.ifr_flags |= IFF_UP;
        require(ioctl(control, SIOCSIFFLAGS, &loopback) == 0, "enable loopback");
    }
    const unsigned interface_index = if_nametoindex("lo");
    require(interface_index != 0, "resolve loopback index");

    const int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_ROUTE);
    require(fd >= 0, "open rtnetlink socket");
    const struct timeval timeout = {.tv_sec = 3};
    require(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0,
            "set rtnetlink receive timeout");
    const struct sockaddr_nl local = {.nl_family = AF_NETLINK};
    require(bind(fd, (const struct sockaddr *)&local, sizeof(local)) == 0, "bind rtnetlink socket");

    const struct in6_addr matching_source = ipv6("2001:db8:1::1");
    const struct in6_addr nonmatching_source = ipv6("2001:db8:2::1");
    const struct in6_addr source_prefix = ipv6("2001:db8:1::");
    const struct in6_addr destination_prefix = ipv6("2001:db8:100::");
    const struct in6_addr destination = ipv6("2001:db8:100::12");
    set_address(fd, interface_index, matching_source, true);
    set_address(fd, interface_index, nonmatching_source, true);
    puts("IPv6 source route: added isolated host addresses without DAD");

    struct route_request route = route_message(interface_index, destination_prefix, source_prefix, true);
    receive_ack(fd, &route.header, "add IPv6 source-prefix route");
    puts("IPv6 source route: installed destination/source prefix route");

    struct route_result result;
    errno = 0;
    require(lookup_route(fd, destination, matching_source, &result) == 0 &&
            result.Type == RTN_UNICAST && result.OutputIndex == interface_index,
            "matching source selects the IPv6 loopback unicast route");
    puts("IPv6 source route: matching source selected loopback unicast route");

    errno = 0;
    require(lookup_route(fd, destination, nonmatching_source, &result) < 0 && errno == ENETUNREACH,
            "nonmatching source returns ENETUNREACH");
    puts("IPv6 source route: nonmatching source returned ENETUNREACH");

    route = route_message(interface_index, destination_prefix, source_prefix, false);
    receive_ack(fd, &route.header, "delete IPv6 source-prefix route");
    errno = 0;
    require(lookup_route(fd, destination, matching_source, &result) < 0 && errno == ENETUNREACH,
            "matching source returns ENETUNREACH after route deletion");
    puts("IPv6 source route: deleted route no longer matches its source prefix");
    set_address(fd, interface_index, nonmatching_source, false);
    set_address(fd, interface_index, matching_source, false);
    require(close(fd) == 0, "close rtnetlink socket");
    if (!(original_flags & IFF_UP)) {
        loopback.ifr_flags = original_flags;
        require(ioctl(control, SIOCSIFFLAGS, &loopback) == 0, "restore loopback flags");
    }
    require(close(control) == 0, "close loopback control socket");
    puts("IPv6 source route: route and addresses removed, descriptors closed");
#ifdef __wasm__
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) pause();
#endif
    return 0;
}
