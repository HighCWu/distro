// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <linux/if_ether.h>
#include <linux/igmp.h>
#include <net/if.h>
#include <netinet/in.h>
#include <netpacket/packet.h>
#include <poll.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *stage)
{
    if (ok) return;
    printf("::vm-test::fail: ipv4 multicast: %s (errno=%d)\n", stage, errno);
    fflush(stdout);
    _Exit(1);
}

static int pending_datagram(int fd, int timeout)
{
    struct pollfd event = {.fd = fd, .events = POLLIN};
    int result;
    do { result = poll(&event, 1, timeout); } while (result < 0 && errno == EINTR);
    require(result >= 0 && (result == 0 || event.revents == POLLIN), "poll receiver");
    return result;
}

static unsigned read_be16(const unsigned char *bytes)
{
    return ((unsigned)bytes[0] << 8) | bytes[1];
}

static int is_igmp_join(const unsigned char *packet, size_t length, struct in_addr group)
{
    static const unsigned char all_v3_routers[] = {224, 0, 0, 22};
    if (length < 20 || packet[0] >> 4 != 4 || packet[9] != IPPROTO_IGMP ||
        packet[8] != 1 || (read_be16(packet + 6) & 0x3fff) != 0 ||
        memcmp(packet + 16, all_v3_routers, sizeof(all_v3_routers)) != 0)
        return 0;
    size_t header = (packet[0] & 15) * 4;
    size_t total = read_be16(packet + 2);
    if (header < 20 || total > length || total < header + 8) return 0;
    const unsigned char *report = packet + header;
    if (report[0] != IGMPV3_HOST_MEMBERSHIP_REPORT) return 0;

    size_t remaining = total - header - 8;
    const unsigned char *record = report + 8;
    int joined = 0;
    for (unsigned records = read_be16(report + 6); records != 0; --records) {
        if (remaining < 8) return 0;
        size_t record_size = 8 + 4 * (read_be16(record + 2) + (unsigned)record[1]);
        if (record_size > remaining) return 0;
        if ((record[0] == IGMPV3_CHANGE_TO_EXCLUDE || record[0] == IGMPV3_MODE_IS_EXCLUDE) &&
            memcmp(record + 4, &group.s_addr, sizeof(group.s_addr)) == 0)
            joined = 1;
        record += record_size;
        remaining -= record_size;
    }
    return joined && remaining == 0;
}

static int packet_endpoint(void)
{
    struct sockaddr_ll local = {
        .sll_family = AF_PACKET,
        .sll_protocol = htons(ETH_P_IP),
        .sll_ifindex = (int)if_nametoindex("lo"),
    };
    require(local.sll_ifindex > 0, "look up loopback for IGMP capture");
    int fd = socket(AF_PACKET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    require(fd >= 0 && bind(fd, (struct sockaddr *)&local, sizeof(local)) == 0,
            "bind IPv4 packet capture to loopback");
    return fd;
}

static int64_t milliseconds(void)
{
    struct timespec now;
    require(clock_gettime(CLOCK_MONOTONIC, &now) == 0, "read IGMP capture deadline clock");
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static void observe_igmp_join(int fd, struct in_addr group)
{
    const int64_t deadline = milliseconds() + 3000;
    for (;;) {
        const int64_t remaining = deadline - milliseconds();
        if (remaining <= 0) break;
        struct pollfd event = {.fd = fd, .events = POLLIN};
        int ready = poll(&event, 1, (int)remaining);
        if (ready < 0 && errno == EINTR) continue;
        if (ready == 0) break;
        require(ready == 1 && event.revents == POLLIN, "wait for an IPv4 packet");
        unsigned char packet[2048];
        ssize_t count = recv(fd, packet, sizeof(packet), MSG_TRUNC);
        if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        require(count >= 0, "receive IPv4 packet for IGMP capture");
        if ((size_t)count <= sizeof(packet) && is_igmp_join(packet, (size_t)count, group))
            return;
    }
    require(0, "observe a kernel IGMPv3 membership report for the joined group");
}

int main(void)
{
#ifdef __wasm__
    require(getpid() == 1, "run as init in the isolated VM");
#endif
    int sender = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    int receiver = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    require(sender >= 0 && receiver >= 0, "open UDP endpoints");

    struct ifreq loop = {.ifr_name = "lo"};
    require(ioctl(sender, SIOCGIFFLAGS, &loop) == 0, "read loopback interface flags");
    short original_flags = loop.ifr_flags;
    if (!(original_flags & IFF_UP)) {
#ifdef __wasm__
        loop.ifr_flags = original_flags | IFF_UP;
        require(ioctl(sender, SIOCSIFFLAGS, &loop) == 0, "bring up private loopback");
#else
        require(close(receiver) == 0 && close(sender) == 0, "close unused sockets");
        puts("ipv4 multicast: native loopback is down");
        return 77;
#endif
    }

    struct sockaddr_in destination = {.sin_family = AF_INET};
    require(bind(receiver, (struct sockaddr *)&destination, sizeof(destination)) == 0,
            "bind receiver to a kernel-selected port");
    socklen_t length = sizeof(destination);
    require(getsockname(receiver, (struct sockaddr *)&destination, &length) == 0 &&
            length == sizeof(destination) && destination.sin_port != 0 &&
            inet_pton(AF_INET, "239.255.42.83", &destination.sin_addr) == 1,
            "select an administratively scoped IPv4 multicast destination");
    struct ip_mreq membership = {
        .imr_multiaddr = destination.sin_addr,
        .imr_interface = {.s_addr = htonl(INADDR_LOOPBACK)},
    };
    const int membership_only = 0;
    const unsigned char ttl = 0, local_loop = 1;
    require(setsockopt(receiver, IPPROTO_IP, IP_MULTICAST_ALL, &membership_only, sizeof(membership_only)) == 0 &&
            setsockopt(sender, IPPROTO_IP, IP_MULTICAST_IF, &membership.imr_interface, sizeof(membership.imr_interface)) == 0 &&
            setsockopt(sender, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl)) == 0 &&
            setsockopt(sender, IPPROTO_IP, IP_MULTICAST_LOOP, &local_loop, sizeof(local_loop)) == 0,
            "restrict transmission and membership to loopback");
    int capture = packet_endpoint();
    require(setsockopt(receiver, IPPROTO_IP, IP_ADD_MEMBERSHIP, &membership, sizeof(membership)) == 0,
            "join the multicast group on loopback");
    observe_igmp_join(capture, membership.imr_multiaddr);
    require(close(capture) == 0, "close IGMP packet capture");
    puts("ipv4 multicast: observed kernel IGMPv3 report for the joined group");

    const unsigned char payload[] = {0, 255, 23, 0, 177, 84};
    require(sendto(sender, payload, sizeof(payload), 0, (struct sockaddr *)&destination, length) == sizeof(payload) &&
            pending_datagram(receiver, 2000) == 1, "send and receive local multicast");
    unsigned char bytes[sizeof(payload) + 1];
    struct sockaddr_in peer;
    socklen_t peer_length = sizeof(peer);
    require(recvfrom(receiver, bytes, sizeof(bytes), MSG_DONTWAIT, (struct sockaddr *)&peer, &peer_length) == sizeof(payload) &&
            !memcmp(bytes, payload, sizeof(payload)) && peer_length == sizeof(peer) &&
            peer.sin_family == AF_INET && peer.sin_addr.s_addr == membership.imr_interface.s_addr,
            "receive the exact datagram from IPv4 loopback");
    puts("ipv4 multicast: joined group and received exact loopback datagram");

    require(setsockopt(receiver, IPPROTO_IP, IP_DROP_MEMBERSHIP, &membership, sizeof(membership)) == 0,
            "leave the multicast group");
    require(sendto(sender, payload, sizeof(payload), 0, (struct sockaddr *)&destination, length) == sizeof(payload) &&
            pending_datagram(receiver, 200) == 0, "no delivery after dropping membership");
#ifdef __wasm__
    if (!(original_flags & IFF_UP)) {
        loop.ifr_flags = original_flags;
        require(ioctl(sender, SIOCSIFFLAGS, &loop) == 0, "restore private loopback flags");
    }
#endif
    require(close(sender) == 0 && close(receiver) == 0, "close UDP endpoints");
    puts("ipv4 multicast: dropped membership, suppressed delivery, and closed sockets");
#ifdef __wasm__
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) sched_yield();
#else
    return 0;
#endif
}
