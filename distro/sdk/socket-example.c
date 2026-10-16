/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#ifdef __wasm__
#include <sched.h>
#endif

#define REQUIRE(test) do { if (!(test)) { \
    fprintf(stderr, "Socket check failed at line %d: %s (errno=%d: %s)\n", \
            __LINE__, #test, errno, strerror(errno)); \
    goto done; \
} } while (0)

static int ready(int fd, short events)
{
    struct pollfd request = { .fd = fd, .events = events };
    int result;
    do { result = poll(&request, 1, 5000); } while (result < 0 && errno == EINTR);
    return result == 1 && (request.revents & events) != 0 &&
           (request.revents & (POLLERR | POLLNVAL)) == 0;
}

static int send_all(int fd, const unsigned char *bytes, size_t length)
{
    while (length) {
        ssize_t sent = send(fd, bytes, length, MSG_NOSIGNAL);
        if (sent < 0 && errno == EINTR) continue;
        if (sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (!ready(fd, POLLOUT)) return 0;
            continue;
        }
        if (sent <= 0) return 0;
        bytes += sent;
        length -= (size_t)sent;
    }
    return 1;
}

static int receive_exact(int fd, unsigned char *bytes, size_t length)
{
    while (length) {
        ssize_t received = recv(fd, bytes, length, 0);
        if (received < 0 && errno == EINTR) continue;
        if (received < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (!ready(fd, POLLIN)) return 0;
            continue;
        }
        if (received <= 0) return 0;
        bytes += received;
        length -= (size_t)received;
    }
    return 1;
}

static int exercise_notifications(int writer, int reader, uint32_t mode)
{
    const unsigned char payload[] = {0, 255, 42, 0, 128, 1, 2};
    const uint64_t identity = UINT64_C(9007199254740993);
    unsigned char buffer[sizeof(payload)];
    int epoll = -1, result = 0;
    struct epoll_event request = { .events = EPOLLIN | mode,
                                  .data.u64 = identity }, event;
    epoll = epoll_create1(EPOLL_CLOEXEC);
    REQUIRE(epoll >= 0);
    REQUIRE(epoll_ctl(epoll, EPOLL_CTL_ADD, reader, &request) == 0);
    for (unsigned round = 0; round < 3; round++) {
        REQUIRE(epoll_wait(epoll, &event, 1, 0) == 0);
        REQUIRE(send_all(writer, payload, sizeof(payload)));
        REQUIRE(epoll_wait(epoll, &event, 1, 5000) == 1);
        REQUIRE(event.data.u64 == request.data.u64 && (event.events & EPOLLIN));
        if (mode & EPOLLONESHOT) {
            /* Unread bytes stay ready, but the registration is disabled.
             * MOD must rearm it immediately and replace its full 64-bit tag. */
            REQUIRE(epoll_wait(epoll, &event, 1, 0) == 0);
            request.data.u64 = identity + round + 1;
            REQUIRE(epoll_ctl(epoll, EPOLL_CTL_MOD, reader, &request) == 0);
            REQUIRE(epoll_wait(epoll, &event, 1, 5000) == 1);
            REQUIRE(event.data.u64 == request.data.u64 && (event.events & EPOLLIN));
            REQUIRE(receive_exact(reader, buffer, sizeof(buffer)));
        } else {
            /* This variant runs on the Unix socketpair, where one small
             * write queues all probe bytes without TCP segmentation. */
            REQUIRE(receive_exact(reader, buffer, 1));
            REQUIRE(epoll_wait(epoll, &event, 1, 0) == 0);
            REQUIRE(receive_exact(reader, buffer + 1, sizeof(buffer) - 1));
        }
        REQUIRE(memcmp(buffer, payload, sizeof(buffer)) == 0);
        REQUIRE(epoll_wait(epoll, &event, 1, 0) == 0);
        errno = 0;
        REQUIRE(recv(reader, buffer, sizeof(buffer), 0) == -1 &&
                (errno == EAGAIN || errno == EWOULDBLOCK));
        if (mode & EPOLLONESHOT)
            REQUIRE(epoll_ctl(epoll, EPOLL_CTL_MOD, reader, &request) == 0);
    }
    REQUIRE(epoll_ctl(epoll, EPOLL_CTL_DEL, reader, NULL) == 0);
    result = 1;
done:
    if (epoll >= 0) close(epoll);
    return result;
}

/* Both endpoints must be nonblocking. The same contract exercises Unix and
 * TCP sockets without a browser network proxy or external server. */
static int exercise(int writer, int reader)
{
    const unsigned char payload[] = {0, 255, 42, 0, 128, 1, 2};
    const uint64_t identity = UINT64_C(9007199254740993);
    unsigned char buffer[sizeof(payload)];
    int epoll = -1, result = 0;
    struct epoll_event request = { .events = EPOLLIN | EPOLLRDHUP,
                                  .data.u64 = identity }, event;
    int writer_flags = fcntl(writer, F_GETFL);
    int reader_flags = fcntl(reader, F_GETFL);
    REQUIRE(writer_flags >= 0 && (writer_flags & O_NONBLOCK) != 0);
    REQUIRE(reader_flags >= 0 && (reader_flags & O_NONBLOCK) != 0);
    errno = 0;
    REQUIRE(recv(reader, buffer, sizeof(buffer), 0) == -1 &&
            (errno == EAGAIN || errno == EWOULDBLOCK));
    struct pollfd pending = { .fd = reader, .events = POLLIN };
    REQUIRE(poll(&pending, 1, 0) == 0);
    epoll = epoll_create1(EPOLL_CLOEXEC);
    REQUIRE(epoll >= 0);
    REQUIRE(epoll_ctl(epoll, EPOLL_CTL_ADD, reader, &request) == 0);
    REQUIRE(epoll_wait(epoll, &event, 1, 0) == 0);
    REQUIRE(send_all(writer, payload, sizeof(payload)));
    REQUIRE(ready(reader, POLLIN));
    REQUIRE(epoll_wait(epoll, &event, 1, 5000) == 1);
    REQUIRE(event.data.u64 == identity && (event.events & EPOLLIN) != 0);
    REQUIRE(receive_exact(reader, buffer, sizeof(buffer)));
    REQUIRE(memcmp(buffer, payload, sizeof(buffer)) == 0);
    REQUIRE(epoll_wait(epoll, &event, 1, 0) == 0);
    REQUIRE(shutdown(writer, SHUT_WR) == 0);
    errno = 0;
    REQUIRE(send(writer, payload, sizeof(payload), MSG_NOSIGNAL) == -1 && errno == EPIPE);
    REQUIRE(epoll_wait(epoll, &event, 1, 5000) == 1);
    REQUIRE(event.data.u64 == identity && (event.events & EPOLLRDHUP) != 0);
    REQUIRE(ready(reader, POLLIN));
    REQUIRE(recv(reader, buffer, sizeof(buffer), 0) == 0);
    /* A write-half shutdown must not destroy the reverse direction. */
    REQUIRE(send_all(reader, payload, sizeof(payload)));
    REQUIRE(receive_exact(writer, buffer, sizeof(buffer)));
    REQUIRE(memcmp(buffer, payload, sizeof(buffer)) == 0);
    REQUIRE(shutdown(reader, SHUT_WR) == 0);
    REQUIRE(ready(writer, POLLIN));
    REQUIRE(recv(writer, buffer, sizeof(buffer), 0) == 0);
    REQUIRE(epoll_ctl(epoll, EPOLL_CTL_DEL, reader, NULL) == 0);
    result = 1;
done:
    if (epoll >= 0) close(epoll);
    return result;
}

static int exercise_udp(void)
{
    const unsigned char payload[] = {0, 255, 42, 0, 128, 1, 2};
    unsigned char buffer[sizeof(payload)], prefix[3] = {99, 99, 99};
    int sender = -1, receiver = -1, result = 0;
    struct sockaddr_in destination = {
        .sin_family = AF_INET, .sin_port = 0,
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    }, source = destination, peer = {0};
    socklen_t length = sizeof(destination);
    sender = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    receiver = socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    REQUIRE(sender >= 0 && receiver >= 0);
    REQUIRE(bind(receiver, (struct sockaddr *)&destination, sizeof(destination)) == 0);
    REQUIRE(getsockname(receiver, (struct sockaddr *)&destination, &length) == 0);
    REQUIRE(length == sizeof(destination) && destination.sin_port != 0);
    REQUIRE(bind(sender, (struct sockaddr *)&source, sizeof(source)) == 0);
    length = sizeof(source);
    REQUIRE(getsockname(sender, (struct sockaddr *)&source, &length) == 0);
    REQUIRE(length == sizeof(source) && source.sin_port != 0);
    errno = 0;
    REQUIRE(recv(receiver, buffer, sizeof(buffer), 0) == -1 &&
            (errno == EAGAIN || errno == EWOULDBLOCK));
    struct iovec pieces[] = {
        { .iov_base = (void *)payload, .iov_len = 2 },
        { .iov_base = (void *)(payload + 2), .iov_len = sizeof(payload) - 2 },
    };
    struct msghdr outgoing = {
        .msg_name = &destination, .msg_namelen = sizeof(destination),
        .msg_iov = pieces, .msg_iovlen = 2,
    };
    REQUIRE(sendmsg(sender, &outgoing, MSG_NOSIGNAL) == (ssize_t)sizeof(payload));
    REQUIRE(ready(receiver, POLLIN));
    struct iovec short_buffer = { .iov_base = prefix, .iov_len = sizeof(prefix) };
    struct msghdr peek = {
        .msg_name = &peer, .msg_namelen = sizeof(peer),
        .msg_iov = &short_buffer, .msg_iovlen = 1,
    };
    /* MSG_TRUNC reports the original record length, not the buffer length;
     * MSG_PEEK must leave that whole record queued for the next receive. */
    REQUIRE(recvmsg(receiver, &peek, MSG_PEEK | MSG_TRUNC) == (ssize_t)sizeof(payload));
    REQUIRE((peek.msg_flags & MSG_TRUNC) != 0 && peek.msg_namelen == sizeof(peer));
    REQUIRE(peer.sin_family == AF_INET && peer.sin_port == source.sin_port &&
            peer.sin_addr.s_addr == source.sin_addr.s_addr);
    REQUIRE(memcmp(prefix, payload, sizeof(prefix)) == 0);
    length = sizeof(peer);
    REQUIRE(recvfrom(receiver, buffer, sizeof(buffer), 0,
                     (struct sockaddr *)&peer, &length) == (ssize_t)sizeof(payload));
    REQUIRE(length == sizeof(peer) && peer.sin_port == source.sin_port &&
            peer.sin_addr.s_addr == source.sin_addr.s_addr);
    REQUIRE(memcmp(buffer, payload, sizeof(buffer)) == 0);
    struct pollfd pending = { .fd = receiver, .events = POLLIN };
    REQUIRE(poll(&pending, 1, 0) == 0);
    REQUIRE(sendto(sender, payload, 0, MSG_NOSIGNAL,
                   (struct sockaddr *)&destination, sizeof(destination)) == 0);
    REQUIRE(sendto(sender, payload, sizeof(payload), MSG_NOSIGNAL,
                   (struct sockaddr *)&destination, sizeof(destination)) == (ssize_t)sizeof(payload));
    REQUIRE(ready(receiver, POLLIN));
    REQUIRE(recv(receiver, buffer, sizeof(buffer), 0) == 0);
    /* Zero bytes above means an empty UDP record, not end-of-stream. */
    REQUIRE(ready(receiver, POLLIN));
    REQUIRE(recv(receiver, buffer, sizeof(buffer), 0) == (ssize_t)sizeof(payload));
    REQUIRE(memcmp(buffer, payload, sizeof(buffer)) == 0);
    REQUIRE(poll(&pending, 1, 0) == 0);
    result = 1;
done:
    if (receiver >= 0) close(receiver);
    if (sender >= 0) close(sender);
    return result;
}

int main(void)
{
    int pair[2] = {-1, -1};
    int listener = -1, client = -1, server = -1, result = EXIT_FAILURE;
    struct sockaddr_in address = {
        .sin_family = AF_INET, .sin_port = 0,
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK),
    };
    socklen_t length = sizeof(address);
    REQUIRE(socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0, pair) == 0);
    REQUIRE(exercise_notifications(pair[0], pair[1], EPOLLET));
    REQUIRE(exercise_notifications(pair[0], pair[1], EPOLLONESHOT));
    REQUIRE(exercise(pair[0], pair[1]));
    puts("SDK sockets: Unix stream nonblocking, poll/epoll and half-close verified");
    listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    REQUIRE(listener >= 0);
#ifdef __wasm__
    /* Raw initramfs starts with lo down. Never reconfigure the build host. */
    struct ifreq loopback = { .ifr_name = "lo" };
    REQUIRE(ioctl(listener, SIOCGIFFLAGS, &loopback) == 0);
    loopback.ifr_flags |= IFF_UP;
    REQUIRE(ioctl(listener, SIOCSIFFLAGS, &loopback) == 0);
#endif
    REQUIRE(bind(listener, (struct sockaddr *)&address, sizeof(address)) == 0);
    REQUIRE(getsockname(listener, (struct sockaddr *)&address, &length) == 0);
    REQUIRE(length == sizeof(address) && address.sin_port != 0);
    REQUIRE(listen(listener, 1) == 0);
    client = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    REQUIRE(client >= 0);
    int connected = connect(client, (struct sockaddr *)&address, length);
    REQUIRE(connected == 0 || (connected == -1 && errno == EINPROGRESS));
    REQUIRE(ready(client, POLLOUT));
    int error = -1;
    length = sizeof(error);
    REQUIRE(getsockopt(client, SOL_SOCKET, SO_ERROR, &error, &length) == 0);
    REQUIRE(length == sizeof(error) && error == 0);
    REQUIRE(ready(listener, POLLIN));
    server = accept4(listener, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    REQUIRE(server >= 0);
    REQUIRE(exercise_notifications(client, server, EPOLLONESHOT));
    REQUIRE(exercise(client, server));
    puts("SDK sockets: TCP loopback nonblocking, poll/epoll and half-close verified");
    puts("SDK sockets: epoll edge-trigger and one-shot rearm verified");
    REQUIRE(exercise_udp());
    puts("SDK sockets: UDP scatter/gather, peek, truncation and empty records verified");
    result = EXIT_SUCCESS;
done:
    if (server >= 0) close(server);
    if (client >= 0) close(client);
    if (listener >= 0) close(listener);
    if (pair[0] >= 0) close(pair[0]);
    if (pair[1] >= 0) close(pair[1]);
    puts(result == EXIT_SUCCESS ? "::vm-test::pass" : "::vm-test::fail");
    fflush(NULL);
#ifdef __wasm__
    if (result == EXIT_SUCCESS)
        for (;;) sched_yield();
#endif
    return result;
}
