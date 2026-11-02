// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

static void check(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: standard setsid: %s errno=%d\n", what, errno);
        exit(1);
    }
}

struct identity { pid_t pid, parent, session, group, tty_session, foreground; };

static int observe(int tty)
{
    struct identity record = { .pid = getpid(), .parent = getppid(),
        .session = getsid(0), .group = getpgrp(), .tty_session = -1, .foreground = -1 };
    if (tty) {
        check(isatty(STDIN_FILENO), "observer stdin is a PTY");
        check(ioctl(STDIN_FILENO, TIOCGSID, &record.tty_session) == 0,
              "read controlling tty session");
        record.foreground = tcgetpgrp(STDIN_FILENO);
    }
    ssize_t count;
    do { count = write(STDOUT_FILENO, &record, sizeof(record)); } while (count < 0 && errno == EINTR);
    check(count == sizeof(record), "observer report");
    return 37;
}

static void reap(pid_t pid, int expected)
{
    int status;
    pid_t result;
    do { result = waitpid(pid, &status, 0); } while (result < 0 && errno == EINTR);
    check(result == pid && WIFEXITED(status) && WEXITSTATUS(status) == expected,
          "setsid wait propagates program status");
    errno = 0;
    check(waitpid(pid, &status, WNOHANG) == -1 && errno == ECHILD, "single tool reap");
}

static void run(const char *tool, const char *self, int force, int leader, int tty, int missing)
{
    const pid_t parent = getpid(), parent_group = getpgrp();
    check(parent > 0 && parent_group > 0, "controller identity before spawn");
    int channel[2];
    check(pipe2(channel, O_CLOEXEC) == 0, "report pipe");
    int master = -1, input;
    if (tty) {
        master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        check(master >= 0 && grantpt(master) == 0 && unlockpt(master) == 0, "create PTY");
        char path[128];
        check(ptsname_r(master, path, sizeof(path)) == 0, "slave path");
        input = open(path, O_RDWR | O_NOCTTY | O_CLOEXEC);
    } else input = open("/dev/null", O_RDONLY | O_CLOEXEC);
    check(input >= 0, "child input");
    posix_spawn_file_actions_t actions;
    posix_spawnattr_t attributes;
    check(posix_spawn_file_actions_init(&actions) == 0 && posix_spawnattr_init(&attributes) == 0,
          "spawn controls");
    check(posix_spawn_file_actions_adddup2(&actions, channel[1], STDOUT_FILENO) == 0 &&
          posix_spawn_file_actions_adddup2(&actions, input, STDIN_FILENO) == 0 &&
          posix_spawn_file_actions_addclose(&actions, channel[0]) == 0 &&
          posix_spawn_file_actions_addclose(&actions, channel[1]) == 0 &&
          posix_spawn_file_actions_addclose(&actions, input) == 0, "child file actions");
    check(posix_spawnattr_setflags(&attributes, POSIX_SPAWN_SETPGROUP) == 0 &&
          posix_spawnattr_setpgroup(&attributes, leader ? 0 : parent_group) == 0,
          "explicit initial process group");
    char *arguments[9];
    int n = 0;
    arguments[n++] = (char *)tool;
    arguments[n++] = "-w";
    if (force) arguments[n++] = "-f";
    if (tty) arguments[n++] = "-c";
    arguments[n++] = missing ? "/setsid-program-does-not-exist" : (char *)self;
    arguments[n++] = "--observe";
    arguments[n++] = tty ? "tty" : "plain";
    arguments[n] = NULL;
    char *environment[] = { "PATH=/bin:/sbin", "LC_ALL=C", NULL };
    pid_t child;
    int error = posix_spawn(&child, tool, &actions, &attributes, arguments, environment);
    if (error) errno = error;
    check(error == 0, "spawn original setsid");
    check(getpid() == parent && getpgrp() == parent_group,
          "spawn preserves controller process identity");
    check(posix_spawnattr_destroy(&attributes) == 0 &&
          posix_spawn_file_actions_destroy(&actions) == 0, "destroy spawn controls");
    check(close(channel[1]) == 0 && close(input) == 0, "parent closes child endpoints");
    struct identity record;
    size_t used = 0;
    for (;;) {
        struct pollfd item = { .fd = channel[0], .events = POLLIN };
        int ready;
        do { ready = poll(&item, 1, 5000); } while (ready < 0 && errno == EINTR);
        check(ready == 1 && (item.revents & (POLLIN | POLLHUP)), "bounded observer report");
        unsigned char buffer[sizeof(record) + 1];
        ssize_t count = read(channel[0], buffer, sizeof(buffer));
        if (count < 0 && errno == EINTR) continue;
        check(count >= 0 && used + (size_t)count <= (missing ? 0 : sizeof(record)),
              "exact observer record");
        if (!count) break;
        memcpy((unsigned char *)&record + used, buffer, (size_t)count);
        used += (size_t)count;
    }
    check(close(channel[0]) == 0, "report fd cleanup");
    reap(child, missing ? 127 : 37);
    if (!missing) {
        check(used == sizeof(record), "complete observer identity");
        /* Retain the full identity contract and report the actual process tree
         * when a platform error changes the tool's fork/exec decision. errno
         * after the single-reap check is ECHILD and cannot diagnose that tree. */
        if (((force || leader) ? record.pid == child : record.pid != child) ||
            record.parent != ((force || leader) ? child : parent) ||
            record.session != record.pid || record.group != record.pid) {
            fprintf(stderr, "standard setsid: identity force=%d leader=%d tty=%d "
                    "controller=%ld controller_group=%ld spawned=%ld observed=%ld "
                    "parent=%ld session=%ld group=%ld\n", force, leader, tty,
                    (long)parent, (long)parent_group, (long)child, (long)record.pid,
                    (long)record.parent, (long)record.session, (long)record.group);
        }
        check(used == sizeof(record) && record.pid > 0 && record.session == record.pid &&
              record.group == record.pid, "program has a new session and group");
        if (force || leader)
            check(record.pid != child && record.parent == child, "real ordinary fork before exec");
        else check(record.pid == child && record.parent == parent, "direct exec without unnecessary fork");
        if (tty) check(record.tty_session == record.pid && record.foreground == record.pid,
                       "child owns controlling terminal and foreground group");
    } else check(!used, "exec failure never enters observer");
    if (master >= 0) check(close(master) == 0, "PTY master cleanup");
}

int main(int argc, char **argv)
{
    if (argc == 3 && !strcmp(argv[1], "--observe")) return observe(!strcmp(argv[2], "tty"));
    check(argc == 1 || argc == 3, "optional tool/self paths");
    const char *tool = argc == 3 ? argv[1] : "/bin/setsid";
    const char *self = argc == 3 ? argv[2] : "/libexec/setsid-fork/verify";
    /* The early boot init tree can inherit group 0. Passing that value to
     * POSIX_SPAWN_SETPGROUP requests the child's own group, rather than the
     * non-leader control required by our direct-exec case. Establish the
     * controller group through the normal syscall before building attributes. */
    if (getpgrp() == 0)
        check(setpgid(0, 0) == 0, "initialize controller process group");
    run(tool, self, 1, 0, 0, 0);
    run(tool, self, 0, 1, 0, 0);
    run(tool, self, 0, 0, 0, 0);
    puts("standard setsid: original forced/automatic fork, direct exec and wait status pass");
    run(tool, self, 1, 0, 1, 0);
    puts("standard setsid: original ctty path, session and foreground PTY ownership pass");
    run(tool, self, 1, 0, 0, 1);
    run(tool, self, 1, 0, 0, 0);
    puts("standard setsid: exec error propagation, later child and descriptor cleanup pass");
    return 0;
}
