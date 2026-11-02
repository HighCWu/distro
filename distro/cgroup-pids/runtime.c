// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define ROOT "/cgroup-pids"
#define LEAF ROOT "/work"

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail cgroup pids: %s (errno=%d)\n", what, errno);
        exit(1);
    }
}

static void control(const char *path, const char *value)
{
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    require(fd >= 0, path);
    size_t length = strlen(value);
    ssize_t count;
    do { count = write(fd, value, length); } while (count < 0 && errno == EINTR);
    require(count == (ssize_t)length, "complete cgroup control write");
    require(close(fd) == 0, "close cgroup control");
}

static void contents(const char *path, char *buffer, size_t capacity)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    require(fd >= 0, path);
    size_t used = 0;
    for (;;) {
        require(used + 1 < capacity, "bounded cgroup read");
        ssize_t count = read(fd, buffer + used, capacity - used - 1);
        if (count < 0 && errno == EINTR) continue;
        require(count >= 0, "read cgroup file");
        if (!count) break;
        used += (size_t)count;
    }
    buffer[used] = 0;
    require(close(fd) == 0, "close cgroup read");
}

static unsigned long long number(const char *text)
{
    char *end;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 10);
    require(text[0] >= '0' && text[0] <= '9' && end != text && !errno &&
            (!*end || (*end == '\n' && !end[1])), "cgroup integer");
    return value;
}

static unsigned long long current(void)
{
    char buffer[64];
    contents(LEAF "/pids.current", buffer, sizeof(buffer));
    return number(buffer);
}

static unsigned long long events(void)
{
    char buffer[128];
    contents(LEAF "/pids.events", buffer, sizeof(buffer));
    require(!strncmp(buffer, "max ", 4), "pids.events max counter");
    return number(buffer + 4);
}

static void denied(void)
{
    errno = 0;
    pid_t child = fork();
    if (!child) _exit(90);
    require(child == -1 && errno == EAGAIN, "ordinary fork limit returns EAGAIN");
}

static void no_children(void)
{
    int status;
    errno = 0;
    require(waitpid(-1, &status, WNOHANG) == -1 && errno == ECHILD,
            "no published or unreaped child");
}

static void wait_child(pid_t child, int expected)
{
    int status;
    pid_t result;
    do { result = waitpid(child, &status, 0); } while (result < 0 && errno == EINTR);
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected,
            "wait and child exit status");
}

static void send_byte(int fd)
{
    ssize_t count;
    do { count = write(fd, "x", 1); } while (count < 0 && errno == EINTR);
    require(count == 1, "pipe handoff write");
}

static void receive_byte(int fd)
{
    struct pollfd item = { .fd = fd, .events = POLLIN };
    int ready;
    do { ready = poll(&item, 1, 5000); } while (ready < 0 && errno == EINTR);
    require(ready == 1 && (item.revents & POLLIN), "bounded child handoff");
    char byte;
    ssize_t count;
    do { count = read(fd, &byte, 1); } while (count < 0 && errno == EINTR);
    require(count == 1 && byte == 'x', "pipe handoff read");
}

int main(void)
{
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages across fork");
    require(mkdir(ROOT, 0755) == 0, "mountpoint");
    require(mount("none", ROOT, "cgroup2", 0, NULL) == 0, "mount standard cgroup v2");
    char buffer[256];
    contents(ROOT "/cgroup.controllers", buffer, sizeof(buffer));
    int found = 0;
    for (char *token = strtok(buffer, " \n"); token; token = strtok(NULL, " \n"))
        if (!strcmp(token, "pids")) found = 1;
    require(found, "PIDs controller available");
    control(ROOT "/cgroup.subtree_control", "+pids");
    require(mkdir(LEAF, 0755) == 0, "create child cgroup");
    control(LEAF "/cgroup.procs", "0");
    require(current() == 1, "caller migrated alone");
    contents(LEAF "/pids.max", buffer, sizeof(buffer));
    require(!strcmp(buffer, "max\n"), "default unlimited group");
    control(LEAF "/pids.max", "1");
    unsigned long long before = events();
    denied();
    require(current() == 1 && events() == before + 1, "limit rollback and event");
    no_children();
    puts("cgroup pids: standard hierarchy, membership and max admission rollback pass");

    control(LEAF "/pids.max", "2");
    int ready[2], release[2];
    require(pipe2(ready, O_CLOEXEC) == 0 && pipe2(release, O_CLOEXEC) == 0, "child pipes");
    pid_t child = fork();
    require(child >= 0, "admitted ordinary fork");
    if (!child) {
        require(close(ready[0]) == 0 && close(release[1]) == 0, "child unused endpoints");
        require(current() == 2, "child inherits group accounting");
        denied();
        require(current() == 2 && events() == before + 2, "inherited limit rollback");
        no_children();
        send_byte(ready[1]);
        receive_byte(release[0]);
        require(close(ready[1]) == 0 && close(release[0]) == 0, "child pipe cleanup");
        _exit(23);
    }
    require(close(ready[1]) == 0 && close(release[0]) == 0, "parent unused endpoints");
    receive_byte(ready[0]);
    require(current() == 2 && events() == before + 2, "live child accounted in same limit");
    send_byte(release[1]);
    wait_child(child, 23);
    require(close(ready[0]) == 0 && close(release[1]) == 0, "parent pipe cleanup");
    require(current() == 1, "reaped task uncharged");
    no_children();
    puts("cgroup pids: inherited child limit, live accounting and wait cleanup pass");

    control(LEAF "/pids.max", "max");
    child = fork();
    require(child >= 0, "fork recovery after unlimited reset");
    if (!child) _exit(37);
    wait_child(child, 37);
    require(current() == 1, "recovery leaves only parent");
    no_children();
    control(ROOT "/cgroup.procs", "0");
    require(current() == 0, "migration removes last task");
    require(rmdir(LEAF) == 0, "remove empty leaf");
    control(ROOT "/cgroup.subtree_control", "-pids");
    require(umount(ROOT) == 0 && rmdir(ROOT) == 0, "hierarchy teardown");
    puts("cgroup pids: unlimited recovery, migration and hierarchy teardown pass");
    return 0;
}
