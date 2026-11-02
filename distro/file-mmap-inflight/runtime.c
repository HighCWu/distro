// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run this mount and process workload only inside Linux on Wasm"
#endif
#include <errno.h>
#include <fcntl.h>
#include <linux/fuse.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define PAGE 65536U
#define FILE_SIZE (3U * PAGE + 17U)
#define ROUNDS 8
struct event { uint32_t kind, node; };
static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: file mmap inflight: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static void send_event(int fd, char kind, uint32_t node)
{
    struct event e = { (unsigned char)kind, node };
    ssize_t n;
    do { n = write(fd, &e, sizeof e); } while (n < 0 && errno == EINTR);
    require(n == (ssize_t)sizeof e, "complete producer event");
}

static void expect_event(int fd, char kind, uint32_t node)
{
    struct pollfd item = { .fd = fd, .events = POLLIN };
    int ready;
    do { ready = poll(&item, 1, 10000); } while (ready < 0 && errno == EINTR);
    require(ready == 1 && (item.revents & POLLIN), "bounded producer handshake");
    struct event e = {0};
    size_t done = 0;
    while (done < sizeof e) {
        ssize_t n = read(fd, (char *)&e + done, sizeof e - done);
        if (n < 0 && errno == EINTR) continue;
        require(n > 0, "read complete producer event");
        done += n;
    }
    require(e.kind == (unsigned char)kind && e.node == node, "ordered producer event identity");
}

static unsigned char value(uint64_t offset, uint64_t node)
{
    return (unsigned char)(offset * 37 + (offset >> 16) * 11 + node);
}

static void reply(int fd, uint64_t unique, int error, const void *data, size_t length,
                  unsigned char *packet)
{
    struct fuse_out_header header = { .len = sizeof header + length,
        .error = -error, .unique = unique };
    require(length <= PAGE, "bounded FUSE reply");
    memcpy(packet, &header, sizeof header);
    if (length && data != packet + sizeof header) memcpy(packet + sizeof header, data, length);
    ssize_t n;
    do { n = write(fd, packet, header.len); } while (n < 0 && errno == EINTR);
    require(n == (ssize_t)header.len, "synchronous FUSE response completed");
}

static struct fuse_attr attributes(uint64_t node)
{
    struct fuse_attr result = { .ino = node, .size = node == 1 ? 0 : FILE_SIZE,
        .mode = node == 1 ? S_IFDIR | 0755 : S_IFREG | 0600,
        .nlink = node == 1 ? 2 : 1, .blksize = PAGE };
    return result;
}

static void data_reply(int device, uint64_t unique, uint64_t node,
                       const struct fuse_read_in *request, unsigned char *packet)
{
    require(request->size <= PAGE, "one-page device producer");
    size_t count = request->offset >= FILE_SIZE ? 0 : FILE_SIZE - request->offset;
    if (count > request->size) count = request->size;
    unsigned char *data = packet + sizeof(struct fuse_out_header);
    for (size_t i = 0; i < count; i++) data[i] = value(request->offset + i, node);
    reply(device, unique, 0, data, count, packet);
}

static void serve(int device, int events, int control)
{
    unsigned char *input = malloc(2 * PAGE), *packet = malloc(PAGE + sizeof(struct fuse_out_header));
    require(input && packet, "bounded server storage");
    uint64_t held_unique = 0, held_node = 0;
    struct fuse_read_in held = {0};
    int stopping = 0;
    while (!stopping) {
        struct pollfd fds[] = { { .fd = device, .events = POLLIN }, { .fd = control, .events = POLLIN } };
        int available;
        do { available = poll(fds, 2, -1); } while (available < 0 && errno == EINTR);
        require(available > 0, "server poll");
        if (fds[1].revents & POLLIN) {
            char command;
            require(read(control, &command, 1) == 1 && command == 'G' && held_unique,
                    "release exactly one held producer");
            data_reply(device, held_unique, held_node, &held, packet);
            send_event(events, 'A', held_node);
            held_unique = held_node = 0;
        }
        if (!(fds[0].revents & (POLLIN | POLLERR | POLLHUP))) continue;
        ssize_t n = read(device, input, 2 * PAGE);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0 && errno == ENODEV) break;
        require(n >= (ssize_t)sizeof(struct fuse_in_header), "device request header");
        struct fuse_in_header header;
        memcpy(&header, input, sizeof header);
        require(header.len == (uint32_t)n, "one complete device request");
        switch (header.opcode) {
        case FUSE_INIT: {
            struct fuse_init_out out = { .major = FUSE_KERNEL_VERSION, .minor = 40,
                .max_write = PAGE, .max_background = 16, .congestion_threshold = 12, .time_gran = 1 };
            reply(device, header.unique, 0, &out, sizeof out, packet);
            send_event(events, 'I', 0);
            break;
        }
        case FUSE_LOOKUP: {
            require(n > (ssize_t)sizeof header && input[n - 1] == 0, "bounded lookup name");
            const char *name = (char *)input + sizeof header;
            unsigned index;
            char suffix;
            uint64_t node = 0;
            if (sscanf(name, "hold%u%c", &index, &suffix) == 1 && index < ROUNDS) node = 10 + index;
            else if (sscanf(name, "ok%u%c", &index, &suffix) == 1 && index < ROUNDS) node = 100 + index;
            if (header.nodeid != 1 || !node) { reply(device, header.unique, ENOENT, NULL, 0, packet); break; }
            struct fuse_entry_out out = { .nodeid = node, .generation = 1,
                .entry_valid = 60, .attr_valid = 60, .attr = attributes(node) };
            reply(device, header.unique, 0, &out, sizeof out, packet);
            break;
        }
        case FUSE_GETATTR: {
            struct fuse_attr_out out = { .attr_valid = 60, .attr = attributes(header.nodeid) };
            reply(device, header.unique, 0, &out, sizeof out, packet);
            break;
        }
        case FUSE_OPEN: {
            /* Direct synchronous reads make the pending producer own the
             * mmap staging buffer, rather than an independent cache folio.
             */
            struct fuse_open_out out = { .fh = header.nodeid, .open_flags = FOPEN_DIRECT_IO };
            reply(device, header.unique, 0, &out, sizeof out, packet);
            break;
        }
        case FUSE_READ: {
            require(n >= (ssize_t)(sizeof header + sizeof(struct fuse_read_in)), "read request payload");
            struct fuse_read_in request;
            memcpy(&request, input + sizeof header, sizeof request);
            if (header.nodeid >= 10 && header.nodeid < 10 + ROUNDS) {
                require(!held_unique && request.offset == 0, "one held first-page producer");
                held_unique = header.unique; held_node = header.nodeid; held = request;
                send_event(events, 'R', header.nodeid);
            } else data_reply(device, header.unique, header.nodeid, &request, packet);
            break;
        }
        case FUSE_INTERRUPT: {
            require(n >= (ssize_t)(sizeof header + sizeof(struct fuse_interrupt_in)), "interrupt payload");
            struct fuse_interrupt_in request;
            memcpy(&request, input + sizeof header, sizeof request);
            require(held_unique && request.unique == held_unique, "interrupt targets the held read");
            /* Ack without finishing the original read. Linux must retain it
             * until the explicit data response; do not disable interrupts.
             */
            reply(device, header.unique, 0, NULL, 0, packet);
            send_event(events, 'X', held_node);
            break;
        }
        case FUSE_RELEASE:
            reply(device, header.unique, 0, NULL, 0, packet);
            if (header.nodeid >= 10 && header.nodeid < 10 + ROUNDS)
                send_event(events, 'L', header.nodeid);
            break;
        case FUSE_FLUSH:
        case FUSE_ACCESS:
            reply(device, header.unique, 0, NULL, 0, packet);
            break;
        case FUSE_FORGET:
        case FUSE_BATCH_FORGET:
            break; // no reply
        case FUSE_DESTROY:
            require(!held_unique, "unmount after all producer completions");
            reply(device, header.unique, 0, NULL, 0, packet);
            stopping = 1;
            break;
        default:
            reply(device, header.unique, ENOSYS, NULL, 0, packet);
        }
    }
    require(!held_unique && close(device) == 0 && close(events) == 0 && close(control) == 0,
            "server connection cleanup");
    free(input); free(packet);
    _exit(0);
}

static void recover(unsigned index)
{
    char path[80];
    require(snprintf(path, sizeof path, "/fuse-producer/ok%u", index) > 0, "recovery path");
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, "fresh recovery source");
    unsigned char *bytes = mmap(NULL, 4 * PAGE, PROT_READ, MAP_PRIVATE, fd, 0);
    require(bytes != MAP_FAILED, "later mapping recovers budget and producer state");
    for (size_t i = 0; i < 4 * PAGE; i++)
        require(bytes[i] == (i < FILE_SIZE ? value(i, 100 + index) : 0), "actual device payload and zero tail");
    require(close(fd) == 0 && munmap(bytes, 4 * PAGE) == 0, "recovery map and source cleanup");
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    require(mkdir("/dev", 0755) == 0 || errno == EEXIST, "device directory");
    require(mount("none", "/dev", "devtmpfs", 0, NULL) == 0, "device mount");
    require(mkdir("/fuse-producer", 0755) == 0, "producer mountpoint");
    int device = open("/dev/fuse", O_RDWR | O_CLOEXEC), events[2], control[2];
    require(device >= 0 && pipe2(events, O_CLOEXEC) == 0 && pipe2(control, O_CLOEXEC) == 0,
            "device and coordination pipes");
    pid_t server = fork();
    require(server >= 0, "independent single-thread producer process");
    if (!server) {
        require(close(events[0]) == 0 && close(control[1]) == 0, "server pipe ownership");
        serve(device, events[1], control[0]);
    }
    require(close(events[1]) == 0 && close(control[0]) == 0, "controller pipe ownership");
    char options[160];
    require(snprintf(options, sizeof options,
            "fd=%d,rootmode=40000,user_id=0,group_id=0,max_read=65536,default_permissions", device) > 0,
            "standard FUSE mount options");
    require(mount("producer", "/fuse-producer", "fuse", MS_NOSUID | MS_NODEV, options) == 0,
            "mount controlled real device");
    expect_event(events[0], 'I', 0);
    require(close(device) == 0, "server owns the remaining device descriptor");
    puts("file mmap inflight: separate FUSE producer, direct reads and standard mount pass");

    for (unsigned index = 0; index < ROUNDS; index++) {
        char path[80];
        require(snprintf(path, sizeof path, "/fuse-producer/hold%u", index) > 0, "held path");
        int source = open(path, O_RDONLY | O_CLOEXEC), result[2];
        require(source >= 0 && pipe2(result, O_CLOEXEC) == 0, "reader source and publication pipe");
        pid_t reader = fork();
        require(reader >= 0, "fork mapping reader");
        if (!reader) {
            close(events[0]); close(control[1]); close(result[0]);
            void *bytes = mmap(NULL, 4 * PAGE, PROT_READ, MAP_PRIVATE, source, 0);
            (void)bytes;
            if (write(result[1], "P", 1) != 1) _exit(91);
            _exit(92); // Returning from mmap after the kill is a failure.
        }
        require(close(source) == 0 && close(result[1]) == 0, "reader exclusively owns source fd");
        expect_event(events[0], 'R', 10 + index);
        require(kill(reader, SIGKILL) == 0, "kill while the real producer is pending");
        expect_event(events[0], 'X', 10 + index);
        int status;
        require(waitpid(reader, &status, WNOHANG) == 0, "sent request retains killed reader until producer returns");
        struct pollfd quiet = { .fd = events[0], .events = POLLIN };
        require(poll(&quiet, 1, 0) == 0, "no release before producer completion");
        require(write(control[1], "G", 1) == 1, "release delayed producer");
        expect_event(events[0], 'A', 10 + index);
        pid_t waited;
        do { waited = waitpid(reader, &status, 0); } while (waited < 0 && errno == EINTR);
        require(waited == reader && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL,
                "actual fatal termination after read completion");
        char marker;
        require(read(result[0], &marker, 1) == 0 && close(result[0]) == 0, "no user publication marker");
        expect_event(events[0], 'L', 10 + index);
        recover(index);
    }
    puts("file mmap inflight: eight held reads, SIGKILL joins, late replies and reference release pass");
    puts("file mmap inflight: repeated ordinary mapping recovery exceeds staging capacity pass");
    require(umount("/fuse-producer") == 0, "unmount after device operations settle");
    int status;
    require(waitpid(server, &status, 0) == server && WIFEXITED(status) && WEXITSTATUS(status) == 0,
            "producer exits and is reaped");
    require(close(events[0]) == 0 && close(control[1]) == 0 && rmdir("/fuse-producer") == 0 &&
            umount("/dev") == 0, "owned descriptors and mounts cleaned");
    puts("file mmap inflight: server reap, unmount and resource cleanup pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
