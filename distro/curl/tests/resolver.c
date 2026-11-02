// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only inside the isolated Linux/Wasm resolver test image"
#endif
#include <arpa/inet.h>
#include <curl/curl.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static _Atomic int stop, dns_seen, recovery_seen, http_completed;
static int dns_fd, http_fd, release_pipe[2];
static int released;

static void require(int ok, const char *operation)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: curl resolver: %s errno=%d\n", operation, errno);
        exit(1);
    }
}

static int64_t now_ms(void)
{
    struct timespec t;
    require(clock_gettime(CLOCK_MONOTONIC, &t) == 0, "monotonic deadline");
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static int ready(int fd, int timeout)
{
    struct pollfd p = { .fd = fd, .events = POLLIN };
    int result;
    do { result = poll(&p, 1, timeout); } while (result < 0 && errno == EINTR);
    require(result >= 0, "server poll");
    if (result) require(p.revents & POLLIN, "server readable event");
    return result;
}

static int bound_socket(int type, unsigned port)
{
    int fd = socket(AF_INET, type | SOCK_CLOEXEC, 0);
    struct sockaddr_in address = { .sin_family = AF_INET,
        .sin_port = htons(port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    require(fd >= 0 && bind(fd, (void *)&address, sizeof address) == 0, "bind loopback fixture");
    return fd;
}

static void *dns_server(void *unused)
{
    (void)unused;
    int held = 0;
    while (!atomic_load(&stop)) {
        if (!ready(dns_fd, 100)) continue;
        unsigned char packet[1024];
        struct sockaddr_in peer = {0};
        socklen_t peer_size = sizeof peer;
        ssize_t n = recvfrom(dns_fd, packet, sizeof packet - 16, 0, (void *)&peer, &peer_size);
        require(n >= 17 && peer_size == sizeof peer && peer.sin_family == AF_INET,
                "bounded DNS question");
        require(packet[4] == 0 && packet[5] == 1, "one DNS question");
        size_t p = 12, used = 0;
        char name[256];
        for (;;) {
            require(p < (size_t)n, "DNS label boundary");
            unsigned length = packet[p++];
            if (!length) break;
            require(length <= 63 && length <= (size_t)n - p &&
                    length + 1 < sizeof name - used, "DNS label bounds");
            if (used) name[used++] = '.';
            memcpy(name + used, packet + p, length);
            used += length; p += length;
        }
        name[used] = 0;
        require((size_t)n - p >= 4 && packet[p] == 0 && packet[p + 1] == 1 &&
                packet[p + 2] == 0 && packet[p + 3] == 1, "IPv4 IN question");
        p += 4;
        if (!strcmp(name, "delayed.threaded.test")) {
            atomic_store(&dns_seen, 1);
            if (!held) {
                held = 1;
                require(ready(release_pipe[0], 5000), "controller releases pending DNS");
                char command;
                require(read(release_pipe[0], &command, 1) == 1 && command == 'G', "DNS release identity");
            }
        } else {
            require(!strcmp(name, "recovery.threaded.test"), "only isolated test names");
            atomic_store(&recovery_seen, 1);
        }
        // Keep the original ID/question; append one compressed A answer.
        packet[2] = 0x81; packet[3] = 0x80;
        packet[6] = 0; packet[7] = 1;
        memset(packet + 8, 0, 4);
        static const unsigned char answer[16] = {
            0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1
        };
        require(p <= sizeof packet - sizeof answer, "bounded DNS response");
        memcpy(packet + p, answer, sizeof answer);
        require(sendto(dns_fd, packet, p + sizeof answer, 0, (void *)&peer, peer_size) ==
                (ssize_t)(p + sizeof answer), "complete DNS response");
    }
    return NULL;
}

static void *http_server(void *unused)
{
    (void)unused;
    while (!atomic_load(&stop)) {
        if (!ready(http_fd, 100)) continue;
        int fd = accept4(http_fd, NULL, NULL, SOCK_CLOEXEC);
        require(fd >= 0, "accept isolated HTTP client");
        char request[2048];
        size_t used = 0;
        request[0] = 0;
        while (!strstr(request, "\r\n\r\n")) {
            require(used < sizeof request - 1 && ready(fd, 5000), "bounded HTTP request");
            ssize_t n = read(fd, request + used, sizeof request - used - 1);
            if (n < 0 && errno == EINTR) continue;
            require(n > 0, "HTTP request bytes");
            used += n; request[used] = 0;
        }
        static const char response[] = "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nDATA";
        size_t sent = 0;
        while (sent < sizeof response - 1) {
            ssize_t n = send(fd, response + sent, sizeof response - 1 - sent, MSG_NOSIGNAL);
            if (n < 0 && errno == EINTR) continue;
            require(n > 0, "HTTP response bytes"); sent += n;
        }
        require(close(fd) == 0, "HTTP accepted descriptor cleanup");
        atomic_fetch_add(&http_completed, 1);
    }
    return NULL;
}

static int fd_count(void)
{
    DIR *directory = opendir("/proc/self/fd");
    require(directory != NULL, "descriptor inventory");
    int count = -1; // Exclude this inventory descriptor.
    struct dirent *entry;
    while ((entry = readdir(directory)))
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) count++;
    require(closedir(directory) == 0, "inventory cleanup");
    return count;
}

static int thread_count(void)
{
    FILE *file = fopen("/proc/self/status", "r");
    require(file != NULL, "thread inventory");
    char line[256];
    int result = -1;
    while (fgets(line, sizeof line, file))
        if (sscanf(line, "Threads: %d", &result) == 1) break;
    require(fclose(file) == 0 && result > 0, "thread inventory result");
    return result;
}

struct transfer { CURL *easy; int done; size_t used; char bytes[4]; };
static size_t body(char *data, size_t size, size_t count, void *opaque)
{
    struct transfer *t = opaque;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length > sizeof t->bytes - t->used) return 0;
    memcpy(t->bytes + t->used, data, length); t->used += length;
    return length;
}

static void add(CURLM *multi, struct transfer *t, const char *url)
{
    t->easy = curl_easy_init();
    require(t->easy != NULL, "easy handle");
#define SET(option, value) require(curl_easy_setopt(t->easy, option, value) == CURLE_OK, #option)
    SET(CURLOPT_URL, url);
    SET(CURLOPT_PROXY, "");
    SET(CURLOPT_NOSIGNAL, 1L);
    SET(CURLOPT_IPRESOLVE, (long)CURL_IPRESOLVE_V4);
    SET(CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
    SET(CURLOPT_CONNECTTIMEOUT_MS, 3000L);
    SET(CURLOPT_TIMEOUT_MS, 5000L);
    SET(CURLOPT_DNS_CACHE_TIMEOUT, 0L);
    SET(CURLOPT_WRITEFUNCTION, body);
    SET(CURLOPT_WRITEDATA, t);
    SET(CURLOPT_PRIVATE, (void *)t);
#undef SET
    require(curl_multi_add_handle(multi, t->easy) == CURLM_OK, "multi add");
}

static void drive(CURLM *multi, struct transfer *fast, struct transfer *named)
{
    int64_t deadline = now_ms() + 10000;
    for (;;) {
        int running, remaining;
        require(curl_multi_perform(multi, &running) == CURLM_OK, "multi perform");
        CURLMsg *message;
        while ((message = curl_multi_info_read(multi, &remaining))) {
            require(message->msg == CURLMSG_DONE && message->data.result == CURLE_OK,
                    "successful completed transfer");
            char *pointer = NULL;
            long status = 0;
            require(curl_easy_getinfo(message->easy_handle, CURLINFO_PRIVATE, &pointer) == CURLE_OK &&
                    curl_easy_getinfo(message->easy_handle, CURLINFO_RESPONSE_CODE, &status) == CURLE_OK &&
                    status == 200, "HTTP result and transfer identity");
            struct transfer *t = (void *)pointer;
            require(t && (t == fast || t == named) && !t->done && t->used == 4 &&
                    !memcmp(t->bytes, "DATA", 4), "exact transfer body");
            if (named && t == named) require(released, "DNS cannot complete before release");
            t->done = 1;
        }
        if (named && fast->done && atomic_load(&dns_seen) && !released) {
            require(!named->done, "independent transfer completes while resolver waits");
            released = 1;
            require(write(release_pipe[1], "G", 1) == 1, "release real DNS response");
        }
        if (fast->done && (!named || named->done)) break;
        require(now_ms() < deadline, "bounded multi progress");
        int descriptors;
        require(curl_multi_poll(multi, NULL, 0, 10, &descriptors) == CURLM_OK, "multi poll");
    }
}

static void remove_transfer(CURLM *multi, struct transfer *t)
{
    require(curl_multi_remove_handle(multi, t->easy) == CURLM_OK, "multi remove");
    curl_easy_cleanup(t->easy);
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    int initial_fds = fd_count();
    dns_fd = bound_socket(SOCK_DGRAM, 53);
    http_fd = bound_socket(SOCK_STREAM, 0);
    require(listen(http_fd, 8) == 0 && pipe2(release_pipe, O_CLOEXEC) == 0, "server setup");
    struct sockaddr_in address = {0};
    socklen_t address_size = sizeof address;
    require(getsockname(http_fd, (void *)&address, &address_size) == 0, "HTTP assigned port");
    pthread_t dns, http;
    require(pthread_create(&dns, NULL, dns_server, NULL) == 0 &&
            pthread_create(&http, NULL, http_server, NULL) == 0, "independent server threads");
    require(curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK, "curl global init");
    const curl_version_info_data *version = curl_version_info(CURLVERSION_NOW);
    require(version && (version->features & CURL_VERSION_ASYNCHDNS) && !version->ares,
            "actual threaded resolver feature");
    CURLM *multi = curl_multi_init();
    require(multi != NULL, "multi handle");
    char fast_url[128], named_url[128], recovery_url[128];
    unsigned port = ntohs(address.sin_port);
    require(snprintf(fast_url, sizeof fast_url, "http://127.0.0.1:%u/fast", port) > 0 &&
            snprintf(named_url, sizeof named_url, "http://delayed.threaded.test:%u/delayed", port) > 0 &&
            snprintf(recovery_url, sizeof recovery_url, "http://recovery.threaded.test:%u/recovery", port) > 0,
            "isolated URLs");
    struct transfer fast = {0}, named = {0}, recovery = {0};
    add(multi, &named, named_url);
    add(multi, &fast, fast_url);
    drive(multi, &fast, &named);
    require(released && atomic_load(&dns_seen), "real pending DNS was released");
    puts("curl resolver: pending DNS does not block an independent multi transfer pass");
    remove_transfer(multi, &fast); remove_transfer(multi, &named);
    add(multi, &recovery, recovery_url);
    drive(multi, &recovery, NULL);
    require(atomic_load(&recovery_seen), "fresh resolver request after cleanup");
    remove_transfer(multi, &recovery);
    require(curl_multi_cleanup(multi) == CURLM_OK, "multi cleanup");
    curl_global_cleanup();
    puts("curl resolver: delayed reply, new DNS request and exact HTTP bodies pass");
    int64_t deadline = now_ms() + 5000;
    while (thread_count() != 3 || atomic_load(&http_completed) != 3) {
        require(now_ms() < deadline, "resolver threads and server responses settle");
        sched_yield();
    }
    atomic_store(&stop, 1);
    require(pthread_join(dns, NULL) == 0 && pthread_join(http, NULL) == 0, "server joins");
    require(close(dns_fd) == 0 && close(http_fd) == 0 && close(release_pipe[0]) == 0 &&
            close(release_pipe[1]) == 0, "owned sockets and pipes close");
    require(thread_count() == 1 && fd_count() == initial_fds, "thread and descriptor recovery");
    puts("curl resolver: resolver/server thread joins, descriptor recovery and cleanup pass");
    return 0;
}
