// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sysexits.h>
#include <time.h>
#include <unistd.h>

static void check(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: standard flock: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static void transfer(int fd, void *data, size_t length, int writing)
{
    size_t done = 0;
    while (done < length) {
        if (!writing) {
            struct pollfd item = { .fd = fd, .events = POLLIN };
            int ready;
            do { ready = poll(&item, 1, 5000); } while (ready < 0 && errno == EINTR);
            check(ready == 1 && (item.revents & POLLIN), "bounded handoff");
        }
        ssize_t count = writing ? write(fd, (char *)data + done, length - done) :
                                  read(fd, (char *)data + done, length - done);
        if (count < 0 && errno == EINTR) continue;
        check(count > 0, "complete handoff record");
        done += (size_t)count;
    }
}

struct identity { pid_t pid, parent; int lock_fds; };

static int observe(const char *path)
{
    struct identity record = { .pid = getpid(), .parent = getppid() };
    struct stat locked;
    check(stat(path, &locked) == 0, "observer lock file identity");
    /* All harness descriptors use CLOEXEC, and the tool opens only its lock
     * file before exec. Inspect identities rather than assuming its fd is 3. */
    for (int fd = 0; fd < 64; fd++) {
        struct stat state;
        if (fstat(fd, &state) == 0 && state.st_dev == locked.st_dev && state.st_ino == locked.st_ino)
            record.lock_fds++;
    }
    transfer(STDOUT_FILENO, &record, sizeof(record), 1);
    char byte;
    transfer(STDIN_FILENO, &byte, 1, 0);
    check(byte == 'x', "child release value");
    return 37;
}

static long long milliseconds(void);

static void reap(pid_t child, int expected)
{
    int status;
    pid_t result;
    long long deadline = milliseconds() + 10000;
    for (;;) {
        result = waitpid(child, &status, WNOHANG);
        if (result < 0 && errno == EINTR) continue;
        if (result) break;
        check(milliseconds() < deadline, "bounded child completion");
        struct timespec pause = { .tv_nsec = 10000000 };
        check(nanosleep(&pause, NULL) == 0 || errno == EINTR, "completion wait tick");
    }
    check(result == child && WIFEXITED(status) && WEXITSTATUS(status) == expected,
          "original flock propagates child status");
    errno = 0;
    check(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD, "single tool reap");
}

static pid_t spawn(const char *tool, char **arguments, int input, int output)
{
    posix_spawn_file_actions_t actions;
    check(posix_spawn_file_actions_init(&actions) == 0, "spawn actions");
    if (input >= 0) check(posix_spawn_file_actions_adddup2(&actions, input, STDIN_FILENO) == 0,
                          "child input");
    if (output >= 0) check(posix_spawn_file_actions_adddup2(&actions, output, STDOUT_FILENO) == 0,
                           "child output");
    char *environment[] = { "PATH=/bin:/sbin", "LC_ALL=C", NULL };
    pid_t child;
    int error = posix_spawn(&child, tool, &actions, NULL, arguments, environment);
    if (error) errno = error;
    check(error == 0, "spawn original flock");
    check(posix_spawn_file_actions_destroy(&actions) == 0, "destroy actions");
    return child;
}

static void conflict(int fd)
{
    errno = 0;
    check(flock(fd, LOCK_EX | LOCK_NB) == -1 && (errno == EWOULDBLOCK || errno == EAGAIN),
          "independent open description conflicts with live tool lock");
}

static void run(const char *tool, const char *self, const char *path, int probe, const char *mode)
{
    int ready[2], release[2];
    check(pipe2(ready, O_CLOEXEC) == 0 && pipe2(release, O_CLOEXEC) == 0, "handoff pipes");
    char *arguments[] = { (char *)tool, (char *)mode, (char *)path, (char *)self,
                          "--observe", (char *)path, NULL };
    pid_t child = spawn(tool, arguments, release[0], ready[1]);
    check(close(ready[1]) == 0 && close(release[0]) == 0, "close parent unused endpoints");
    struct identity record;
    transfer(ready[0], &record, sizeof(record), 0);
    check(record.lock_fds == (!strcmp(mode, "-o") ? 0 : 1),
          "close mode removes child lock fd while other modes inherit exactly one");
    if (!strcmp(mode, "-F"))
        check(record.pid == child && record.parent == getpid(), "no-fork direct exec identity");
    else check(record.pid != child && record.parent == child, "real ordinary fork and child exec");
    conflict(probe);
    char byte = 'x';
    transfer(release[1], &byte, 1, 1);
    reap(child, 37);
    check(close(ready[0]) == 0 && close(release[1]) == 0, "handoff fd cleanup");
    check(flock(probe, LOCK_EX | LOCK_NB) == 0 && flock(probe, LOCK_UN) == 0,
          "lock released after child and parent exit");
}

static long long milliseconds(void)
{
    struct timespec time;
    check(clock_gettime(CLOCK_MONOTONIC, &time) == 0, "monotonic timer");
    return (long long)time.tv_sec * 1000 + time.tv_nsec / 1000000;
}

int main(int argc, char **argv)
{
    if (argc == 3 && !strcmp(argv[1], "--observe")) return observe(argv[2]);
    check(argc == 1 || argc == 3, "optional tool/self paths");
    const char *tool = argc == 3 ? argv[1] : "/bin/flock";
    const char *self = argc == 3 ? argv[2] : "/libexec/flock-fork/verify";
    char path[] = "/tmp/linux-wasm-flock-XXXXXX";
    int probe = mkostemp(path, O_CLOEXEC);
    check(probe >= 0, "independent lock file");
    run(tool, self, path, probe, "-x");
    run(tool, self, path, probe, "-o");
    puts("standard flock: original fork/wait, close mode and cross-process lock lifetime pass");
    run(tool, self, path, probe, "-F");
    puts("standard flock: direct exec identity and inherited lock lifetime pass");
    check(flock(probe, LOCK_EX) == 0, "hold conflicting parent lock");
    char *nonblocking[] = { (char *)tool, "-n", "-E", "42", path, "/bin/true", NULL };
    reap(spawn(tool, nonblocking, -1, -1), 42);
    char *timed[] = { (char *)tool, "-w", "0.1", "-E", "43", path, "/bin/true", NULL };
    long long before = milliseconds();
    reap(spawn(tool, timed, -1, -1), 43);
    check(milliseconds() - before >= 50, "real timeout does not return immediately");
    check(flock(probe, LOCK_UN) == 0, "release parent lock after timeout");
    puts("standard flock: nonblocking conflict and original timer/signal timeout pass");
    char *missing[] = { (char *)tool, path, "/flock-program-does-not-exist", NULL };
    reap(spawn(tool, missing, -1, -1), EX_UNAVAILABLE);
    run(tool, self, path, probe, "-x");
    check(close(probe) == 0 && unlink(path) == 0, "lock file teardown");
    puts("standard flock: exec error, later acquisition and descriptor cleanup pass");
    return 0;
}
