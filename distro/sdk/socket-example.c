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
    REQUIRE(exercise(client, server));
    puts("SDK sockets: TCP loopback nonblocking, poll/epoll and half-close verified");
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
