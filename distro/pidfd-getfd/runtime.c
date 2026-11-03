// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: pidfd getfd: %s errno=%d\n", what, errno);
    exit(1);
}
static void transfer(int fd, void *data, size_t size, int writing)
{
    char *bytes = data;
    while (size) {
        ssize_t n = writing ? write(fd, bytes, size) : read(fd, bytes, size);
        if (n < 0 && errno == EINTR) continue;
        require(n > 0, "bounded pipe handshake");
        bytes += n;
        size -= n;
    }
}
static char receive(int fd)
{
    char value;
    transfer(fd, &value, 1, 0);
    return value;
}
static void command_send(int fd, char value) { transfer(fd, &value, 1, 1); }
static long copy_fd(int pidfd, int fd, long flags)
{
    // Existing musl syscall(), not a new libc wrapper. All six registers are
    // machine words on both pointer widths, including unused zero arguments.
    return syscall(SYS_pidfd_getfd, (long)pidfd, (long)fd, flags, 0L, 0L, 0L);
}
static void reap(pid_t pid, int code)
{
    int status;
    pid_t got;
    do { got = waitpid(pid, &status, 0); } while (got < 0 && errno == EINTR);
    require(got == pid && WIFEXITED(status) && WEXITSTATUS(status) == code, "exact child reap");
}

static struct cmsghdr *next_control(struct msghdr *message, struct cmsghdr *header)
{
    // The upstream macro compares size_t with ptrdiff_t. Do not alter libc's
    // generic macro or weaken warnings for the rest of this consumer.
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wsign-compare"
    return CMSG_NXTHDR(message, header);
#pragma GCC diagnostic pop
}

static void unix_rights(const char *path, int truncated)
{
    int sockets[2];
    require(socketpair(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC, 0, sockets) == 0, "Unix datagram pair");
    int enabled = 1;
    if (!truncated)
        require(setsockopt(sockets[0], SOL_SOCKET, SO_PASSCRED, &enabled, sizeof enabled) == 0,
                "request actual sender credentials");
    pid_t child = fork();
    require(child >= 0, "Unix rights sender fork");
    if (!child) {
        close(sockets[0]);
        int fds[2];
        fds[0] = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
        require(fds[0] >= 0 && write(fds[0], "abcdef", 6) == 6 && lseek(fds[0], 2, SEEK_SET) == 2,
                "create non-inherited rights file");
        fds[1] = truncated ? dup(fds[0]) : -1;
        require(!truncated || fds[1] >= 0, "duplicate second in-flight reference");
        union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(2 * sizeof(int))]; } control = {0};
        char byte = 'x';
        struct iovec io = {.iov_base = &byte, .iov_len = 1};
        struct msghdr message = {.msg_iov = &io, .msg_iovlen = 1, .msg_control = control.bytes,
                                .msg_controllen = CMSG_SPACE((truncated ? 2 : 1) * sizeof(int))};
        struct cmsghdr *header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = SOL_SOCKET;
        header->cmsg_type = SCM_RIGHTS;
        header->cmsg_len = CMSG_LEN((truncated ? 2 : 1) * sizeof(int));
        memcpy(CMSG_DATA(header), fds, (truncated ? 2 : 1) * sizeof(int));
        require(sendmsg(sockets[1], &message, MSG_NOSIGNAL) == 1, "queue rights and payload");
        require(close(fds[0]) == 0 && (!truncated || close(fds[1]) == 0) && unlink(path) == 0,
                "close and unlink before receiver obtains descriptor");
        _exit(0);
    }
    close(sockets[1]);
    // The message, not a live source process or pathname, retains the file.
    reap(child, 0);
    int first = dup(sockets[0]), second = dup(sockets[0]);
    require(first >= 0 && second >= 0 && close(first) == 0 && close(second) == 0, "capture free receiver slots");
    union { struct cmsghdr align; unsigned char bytes[CMSG_SPACE(sizeof(struct ucred)) + CMSG_SPACE(2 * sizeof(int))]; } control = {0};
    char byte = 0;
    struct iovec io = {.iov_base = &byte, .iov_len = 1};
    struct msghdr message = {.msg_iov = &io, .msg_iovlen = 1, .msg_control = control.bytes,
                            .msg_controllen = truncated ? CMSG_LEN(sizeof(int)) : sizeof control.bytes};
#ifdef KEEP_CONTROL_ROOM
    if (truncated) message.msg_controllen = sizeof control.bytes;
#endif
    int flags = MSG_CMSG_CLOEXEC;
#ifdef DROP_CMSG_CLOEXEC
    flags = 0;
#endif
    require(recvmsg(sockets[0], &message, flags) == 1 && byte == 'x' &&
            !!(message.msg_flags & MSG_CTRUNC) == truncated,
            "exact one-FD truncation status and payload");
    int received = -1, rights = 0, credentials = 0;
    for (struct cmsghdr *header = CMSG_FIRSTHDR(&message); header; header = next_control(&message, header)) {
        require(header->cmsg_level == SOL_SOCKET, "socket ancillary level");
        if (header->cmsg_type == SCM_RIGHTS) {
            require(header->cmsg_len == CMSG_LEN(sizeof(int)) && !rights++, "exactly one delivered descriptor");
            memcpy(&received, CMSG_DATA(header), sizeof received);
        } else if (header->cmsg_type == SCM_CREDENTIALS) {
            struct ucred sender;
            require(header->cmsg_len == CMSG_LEN(sizeof sender) && !credentials++, "one complete credential record");
            memcpy(&sender, CMSG_DATA(header), sizeof sender);
            require(sender.pid == child && sender.uid == getuid() && sender.gid == getgid(),
                    "credentials identify the exited actual sender");
        } else require(0, "unexpected ancillary record");
    }
    require(rights == 1 && credentials == !truncated && received == first &&
            (fcntl(received, F_GETFD) & FD_CLOEXEC), "received descriptor close-on-exec and record count");
    struct stat attrs;
    char data[4];
    require(fstat(received, &attrs) == 0 && S_ISREG(attrs.st_mode) && attrs.st_nlink == 0 &&
            lseek(received, 0, SEEK_CUR) == 2 && read(received, data, 4) == 4 && !memcmp(data, "cdef", 4) &&
            close(received) == 0, "queued open description survives sender exit and retains offset");
    int after_first = dup(sockets[0]), after_second = dup(sockets[0]);
    require(after_first == first && after_second == second && close(after_first) == 0 &&
            close(after_second) == 0 && close(sockets[0]) == 0, "truncated rights leak no receiver fd slots");
    puts(truncated ? "unix rights: one-FD control truncation, CLOEXEC and excess descriptor cleanup pass" :
         "unix rights: queued descriptor and sender credentials survive close, unlink and reap pass");
}
int main(int argc, char **argv)
{
    setvbuf(stdout, NULL, _IONBF, 0);
#ifdef __wasm__
    (void)argc; (void)argv;
    const char *path = "/pidfd-private-file";
#else
    require(argc == 2, "native reference requires an isolated temporary path");
    const char *path = argv[1];
#endif
    int command[2], report[2];
    require(pipe2(command, O_CLOEXEC) == 0 && pipe2(report, O_CLOEXEC) == 0, "create handshake pipes");
    pid_t child = fork();
    require(child >= 0, "fork independent file table");
    if (!child) {
        close(command[1]); close(report[0]);
        // Created after fork: the parent cannot inherit this open description.
        int fd = open(path, O_CREAT | O_EXCL | O_RDWR, 0600);
        require(fd >= 0 && write(fd, "abcdef", 6) == 6 && lseek(fd, 0, SEEK_SET) == 0,
                "create child-only file description");
        transfer(report[1], &fd, sizeof fd, 1);
        char step = receive(command[0]);
        if (step == 'q') { close(fd); unlink(path); _exit(0); }
        require(step == 'x' && fcntl(fd, F_GETFD) == 0, "copy CLOEXEC does not alter child descriptor");
        char data[2];
        require(read(fd, data, 2) == 2 && data[0] == 'c' && data[1] == 'd', "parent read advances child's offset");
        int flags = fcntl(fd, F_GETFL);
        require(flags >= 0 && fcntl(fd, F_SETFL, flags | O_APPEND) == 0, "change shared file status");
        command_send(report[1], 'x');
        require(receive(command[0]) == 'c', "close command");
        require(unlink(path) == 0 && close(fd) == 0, "unlink and close source descriptor");
        command_send(report[1], 'c');
        require(receive(command[0]) == 'e', "exit command");
        _exit(37);
    }
    close(command[0]); close(report[1]);
    int target;
    transfer(report[0], &target, sizeof target, 0);
    int pidfd = syscall(SYS_pidfd_open, (long)child, 0L, 0L, 0L, 0L, 0L);
    require(pidfd >= 0, "open live child pidfd");
    int copied = copy_fd(pidfd, target, 0);
#ifndef __wasm__
    if (copied < 0 && (errno == EPERM || errno == EACCES || errno == ENOSYS)) {
        int unavailable = errno;
        command_send(command[1], 'q');
        reap(child, 0);
        close(pidfd); close(command[1]); close(report[0]);
        fprintf(stderr, "native pidfd_getfd unavailable under host policy errno=%d; no runtime acceptance\n", unavailable);
        return 77;
    }
#endif
    struct stat attrs;
    require(copied >= 0 && (fcntl(copied, F_GETFD) & FD_CLOEXEC) &&
            fstat(copied, &attrs) == 0 && S_ISREG(attrs.st_mode) && attrs.st_size == 6,
            "copy a CLOEXEC reference to the actual child-only file");
#ifdef FORCE_LOCAL_DUP
    close(copied);
    copied = dup(target);
    require(copied >= 0, "negative local duplicate");
#endif
    char data[2];
    require(read(copied, data, 2) == 2 && data[0] == 'a' && data[1] == 'b', "copied descriptor reads child data");
    command_send(command[1], 'x');
    require(receive(report[0]) == 'x' && lseek(copied, 0, SEEK_CUR) == 4 &&
            (fcntl(copied, F_GETFL) & O_APPEND), "child read and status changes reach parent description");
    puts("pidfd getfd: child-only file, independent CLOEXEC, shared offset and status flags pass");
    int slot = dup(copied);
    require(slot >= 0 && close(slot) == 0, "capture next free descriptor slot");
    errno = 0;
    require(copy_fd(pidfd, target, 1) == -1 && errno == EINVAL, "unknown flags rejected");
    errno = 0;
    require(copy_fd(-1, target, 0) == -1 && errno == EBADF, "invalid pidfd rejected");
    errno = 0;
    require(copy_fd(copied, target, 0) == -1 && errno == EBADF, "ordinary file is not a pidfd");
    errno = 0;
    require(copy_fd(pidfd, -1, 0) == -1 && errno == EBADF, "invalid remote descriptor rejected");
    int again = copy_fd(pidfd, target, 0);
    require(again == slot && (fcntl(again, F_GETFD) & FD_CLOEXEC) &&
            lseek(again, 0, SEEK_CUR) == 4 && close(again) == 0,
            "failed calls leak no descriptor and later copy reuses shared description");
    puts("pidfd getfd: flags, wrong handle, remote EBADF, allocation cleanup and retry pass");
    command_send(command[1], 'c');
    require(receive(report[0]) == 'c', "child source closed before next probe");
    errno = 0;
    require(copy_fd(pidfd, target, 0) == -1 && errno == EBADF, "closed source is unavailable while child lives");
    command_send(command[1], 'e');
    reap(child, 37);
    struct pollfd ready = {.fd = pidfd, .events = POLLIN};
    require(poll(&ready, 1, 0) == 1 && (ready.revents & POLLIN), "pidfd observes reaped child exit");
    errno = 0;
    require(copy_fd(pidfd, target, 0) == -1 && errno == ESRCH, "reaped source process is gone");
    require(fstat(copied, &attrs) == 0 && attrs.st_nlink == 0 &&
            read(copied, data, 2) == 2 && data[0] == 'e' && data[1] == 'f',
            "copied reference survives unlink, source close and process reap");
    require(close(copied) == 0 && close(pidfd) == 0 && close(command[1]) == 0 && close(report[0]) == 0,
            "close copied and control descriptors");
    child = fork();
    require(child >= 0, "later ordinary fork");
    if (!child) _exit(42);
    reap(child, 42);
    errno = 0;
    int status;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD, "no unreaped child remains");
    puts("pidfd getfd: copied file survives source lifetime and ordinary fork recovery pass");
    unix_rights(path, 0);
    unix_rights(path, 1);
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#else
    return 0;
#endif
}
