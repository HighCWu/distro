// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fanotify.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

_Static_assert(sizeof(struct fanotify_event_metadata) == 24, "standard event header size");
_Static_assert(sizeof(struct fanotify_response) == 8, "standard response size");
static const char contents[] = "a\0file";

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: fanotify: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static int decode(const void *data, size_t size, struct fanotify_event_metadata *event)
{
    if (size < sizeof *event) return 0;
    memcpy(event, data, sizeof *event);
    return event->vers == FANOTIFY_METADATA_VERSION &&
           event->metadata_len >= sizeof *event &&
           event->event_len >= event->metadata_len && event->event_len <= size;
}

static int ready(int fd, int timeout)
{
    struct pollfd p = {.fd = fd, .events = POLLIN};
    int ret;
    do ret = poll(&p, 1, timeout); while (ret < 0 && errno == EINTR);
    require(ret >= 0 && !(p.revents & (POLLERR | POLLHUP | POLLNVAL)), "notification poll");
    return ret > 0 && (p.revents & POLLIN);
}

static void identity(int fd, const struct stat *original)
{
    struct stat st;
    char data[sizeof contents];
    require(fstat(fd, &st) == 0 && st.st_dev == original->st_dev && st.st_ino == original->st_ino &&
            (fcntl(fd, F_GETFD) & FD_CLOEXEC), "event descriptor identity and CLOEXEC");
    require(pread(fd, data, sizeof data, 0) == sizeof data && !memcmp(data, contents, sizeof data),
            "event descriptor refers to original bytes");
}

static void produce(const char *path)
{
    int fd = open(path, O_RDWR | O_CLOEXEC);
    require(fd >= 0 && close(fd) == 0, "produce open and close-write events");
}

static void admin_boundary(void)
{
    struct { uint32_t version; int pid; } header = {0x20080522, 0};
    struct capword { uint32_t effective, permitted, inheritable; } saved[2], limited[2];
    require(syscall(SYS_capget, (long)&header, (long)saved, 0L, 0L, 0L, 0L) == 0 &&
            (saved[0].effective & (1u << 21)), "initial CAP_SYS_ADMIN");
    memcpy(limited, saved, sizeof saved);
    limited[0].effective &= ~(1u << 21);
    require(syscall(SYS_capset, (long)&header, (long)limited, 0L, 0L, 0L, 0L) == 0,
            "temporarily remove effective admin capability");
    errno = 0;
    int fd = fanotify_init(FAN_CLOEXEC | FAN_NONBLOCK, O_RDONLY | O_CLOEXEC);
    int error = errno;
    if (fd >= 0) close(fd);
    int restored = syscall(SYS_capset, (long)&header, (long)saved, 0L, 0L, 0L, 0L);
    require(restored == 0 && fd == -1 && error == EPERM, "admin permission enforced and restored");
}

struct request { const char *path; int result, error; };
static void *open_request(void *argument)
{
    struct request *request = argument;
    int fd = open(request->path, O_RDONLY | O_CLOEXEC);
    request->error = errno;
    request->result = fd < 0 ? -1 : 0;
    if (fd >= 0 && close(fd)) request->result = -2;
    return NULL;
}

static void permission_events(const char *path, const struct stat *original)
{
    int group = fanotify_init(FAN_CLASS_CONTENT | FAN_NONBLOCK | FAN_CLOEXEC, O_RDONLY | O_CLOEXEC);
    require(group >= 0 && fanotify_mark(group, FAN_MARK_ADD, FAN_OPEN_PERM, AT_FDCWD, path) == 0,
            "create permission group and mark");
    for (int allow = 0; allow < 2; ++allow) {
        struct request request = {.path = path, .result = -3};
        pthread_t thread;
        require(pthread_create(&thread, NULL, open_request, &request) == 0, "start blocked permission request");
        require(ready(group, 10000), "permission request reaches listener");
        unsigned char bytes[sizeof(struct fanotify_event_metadata)];
        ssize_t length = read(group, bytes, sizeof bytes);
        struct fanotify_event_metadata event;
        require(length == sizeof bytes && decode(bytes, (size_t)length, &event) &&
                event.mask == FAN_OPEN_PERM && event.fd >= 0 && event.pid == getpid(),
                "permission event metadata");
        identity(event.fd, original);
        struct fanotify_response response = {.fd = event.fd, .response = 0};
        errno = 0;
        require(write(group, &response, sizeof response) == -1 && errno == EINVAL,
                "invalid permission response leaves request pending");
        response.response = allow ? FAN_ALLOW : FAN_DENY;
        require(write(group, &response, sizeof response) == sizeof response && close(event.fd) == 0,
                "reply and close permission descriptor");
        void *returned;
        require(pthread_join(thread, &returned) == 0 && returned == NULL &&
                (allow ? request.result == 0 : request.result == -1 && request.error == EACCES),
                "permission reply controls actual open result");
    }
    require(!ready(group, 0) && close(group) == 0, "permission group drained and closed");
}

#ifndef __wasm__
static int protocol_reference(void)
{
    struct fanotify_event_metadata valid = {
        .event_len = sizeof valid, .vers = FANOTIFY_METADATA_VERSION,
        .metadata_len = sizeof valid, .fd = 7, .pid = 1, .mask = FAN_OPEN,
    }, event;
    require(decode(&valid, sizeof valid, &event), "valid native event framing");
    require(!decode(&valid, sizeof valid - 1, &event), "short native header rejected");
    valid.event_len++;
    require(!decode(&valid, sizeof valid, &event), "truncated native event rejected");
    valid.event_len = sizeof valid;
    valid.metadata_len = sizeof valid + 1;
    require(!decode(&valid, sizeof valid, &event), "inconsistent native metadata length rejected");
    valid.metadata_len = sizeof valid;
    valid.vers++;
    require(!decode(&valid, sizeof valid, &event), "unknown native protocol rejected");
    puts("fanotify: native event framing reference pass (not kernel notification evidence)");
    return 0;
}
#endif

int main(int argc, char **argv)
{
#ifndef __wasm__
    if (argc == 2 && !strcmp(argv[1], "--protocol")) return protocol_reference();
#else
    (void)argc; (void)argv;
#endif
    admin_boundary();
    errno = 0;
    require(fanotify_init(0x80000000u, O_RDONLY) == -1 && errno == EINVAL, "unknown init flag rejected");
    char directory[] = "/tmp/fanotify-XXXXXX", path[512];
    require(mkdtemp(directory) != NULL, "create watched directory");
    int length = snprintf(path, sizeof path, "%s/file", directory);
    require(length > 0 && (size_t)length < sizeof path, "watched file path");
    int file = open(path, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
    struct stat original;
    require(file >= 0 && write(file, contents, sizeof contents) == sizeof contents &&
            fstat(file, &original) == 0 && close(file) == 0, "create watched bytes");
    int group = fanotify_init(FAN_CLASS_NOTIF | FAN_NONBLOCK | FAN_CLOEXEC, O_RDONLY | O_CLOEXEC);
    const unsigned long long mask = FAN_OPEN | FAN_CLOSE_WRITE | FAN_EVENT_ON_CHILD;
    require(group >= 0 && (fcntl(group, F_GETFD) & FD_CLOEXEC) &&
            (fcntl(group, F_GETFL) & O_NONBLOCK), "notification descriptor flags");
    require(fanotify_mark(group, FAN_MARK_ADD | FAN_MARK_ONLYDIR, mask, AT_FDCWD, directory) == 0,
            "mark child access events");
    errno = 0;
    require(fanotify_mark(group, FAN_MARK_ADD, mask | (1ULL << 63), AT_FDCWD, directory) == -1 &&
            errno == EINVAL, "high mask bits survive wasm32 split-word ABI and are rejected");
    produce(path);
    require(ready(group, 0), "open/close events readable");
    unsigned char buffer[1024];
    errno = 0;
    require(read(group, buffer, 1) == -1 && errno == EINVAL && ready(group, 0),
            "short read does not consume pending events");
    unsigned long long seen = 0;
    for (int batch = 0; ready(group, 0); ++batch) {
        require(batch < 8, "bounded event drain");
        ssize_t n = read(group, buffer, sizeof buffer);
        require(n > 0, "read notification records");
        for (size_t offset = 0; offset < (size_t)n;) {
            struct fanotify_event_metadata event;
            require(decode(buffer + offset, (size_t)n - offset, &event) &&
                    event.fd >= 0 && event.pid == getpid() && !(event.mask & FAN_Q_OVERFLOW),
                    "notification metadata, PID and no overflow");
            identity(event.fd, &original);
            seen |= event.mask;
            require(close(event.fd) == 0, "close notification descriptor");
            offset += event.event_len;
        }
    }
    require((seen & (FAN_OPEN | FAN_CLOSE_WRITE)) == (FAN_OPEN | FAN_CLOSE_WRITE), "both event classes delivered");
    errno = 0;
    require(read(group, buffer, sizeof buffer) == -1 && errno == EAGAIN, "empty nonblocking group");
    puts("fanotify: child events, descriptor identity, binary bytes and bounded reads pass");
    require(fanotify_mark(group, FAN_MARK_REMOVE, mask, AT_FDCWD, directory) == 0, "remove mark");
    produce(path);
    require(!ready(group, 0), "removed mark no longer emits events");
    require(fanotify_mark(group, FAN_MARK_ADD, mask, AT_FDCWD, directory) == 0 &&
            fanotify_mark(group, FAN_MARK_FLUSH, 0, AT_FDCWD, NULL) == 0, "re-add and flush marks");
    produce(path);
    require(!ready(group, 0) && close(group) == 0, "flushed group remains empty and closes");
    puts("fanotify: high-word masks, mark removal, flush and queue cleanup pass");
    permission_events(path, &original);
    puts("fanotify: invalid response recovery, denied and allowed threaded opens pass");
    require(unlink(path) == 0 && rmdir(directory) == 0, "watched file cleanup");
    puts("fanotify: admin permission boundary, restored credentials and final cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
