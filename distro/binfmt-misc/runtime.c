// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: binfmt-misc: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static void command(const char *path, const char *value)
{
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    require(fd >= 0 && write(fd, value, strlen(value)) == (ssize_t)strlen(value) &&
            close(fd) == 0, "registration or control write");
}

static void run(const char *mode, int expected_errno)
{
    pid_t child = fork();
    require(child >= 0, "fork for interpreted exec");
    if (!child) {
        /* Reserve descriptor zero across exec: an uninitialized execfd=0 must
         * not accidentally name the actual binary in an otherwise empty table. */
        if (fcntl(0, F_GETFD) == -1) {
            int input = open("/dev/null", O_RDONLY);
            if (input < 0 || (input && dup2(input, 0) != 0)) _exit(90);
            if (input) close(input);
        }
        if (fcntl(0, F_SETFD, 0)) _exit(90);
        if ((!strcmp(mode, "open") || !strcmp(mode, "creds")) &&
            (setgroups(0, NULL) || setresgid(1000, 1000, 1000) || setresuid(1000, 1000, 1000))) _exit(91);
        char *args[] = {"original-zero", "tail-token", NULL};
        char env_mode[64];
        snprintf(env_mode, sizeof env_mode, "BINFMT_CASE=%s", mode);
        char *env[] = {env_mode, "BINFMT_SENTINEL=present", NULL};
        errno = 0;
        execve("/misc-payload", args, env);
        if (!expected_errno || errno != expected_errno) _exit(92);
        _exit(37);
    }
    int status = 0;
    pid_t waited;
    do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
    if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 37) {
        printf("binfmt-misc: case=%s waited=%ld status=%#x expected-errno=%d\n",
               mode, (long)waited, status, expected_errno);
        require(0, "interpreted exec result");
    }
    require(getuid() == 0 && geteuid() == 0, "parent credentials unchanged");
}

static void registration(const char *flags)
{
    char line[128];
    snprintf(line, sizeof line, ":wasm-test:M::WBIN::/misc-helper:%s", flags);
    command("/misc-formats/register", line);
}

int main(void)
{
    require(mkdir("/misc-formats", 0755) == 0 &&
            mount("none", "/misc-formats", "binfmt_misc", 0, NULL) == 0, "mount standard binfmt_misc");
    if (mknod("/dev/null", S_IFCHR | 0666, makedev(1, 3))) require(errno == EEXIST, "null device");
    require(chmod("/dev/null", 0666) == 0 && chmod("/misc-helper", 0755) == 0, "interpreter modes");
    const unsigned char payload[] = {'W','B','I','N',0,0xff,0x7f,42};
    int fd = open("/misc-payload", O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0700);
    require(fd >= 0 && write(fd, payload, sizeof payload) == sizeof payload && close(fd) == 0 &&
            chmod("/misc-payload", 04755) == 0, "setuid binary payload");
    run("unregistered", ENOEXEC);
    registration("");
    run("plain", 0);
    command("/misc-formats/wasm-test", "0");
    run("disabled-entry", ENOEXEC);
    command("/misc-formats/wasm-test", "1");
    run("plain", 0);
    command("/misc-formats/status", "0");
    run("disabled-global", ENOEXEC);
    command("/misc-formats/status", "1");
    command("/misc-formats/wasm-test", "-1");
    puts("binfmt-misc: registration, ordinary argv and entry/global disable recovery pass");
    fflush(stdout);
    registration("P");
    run("preserve", 0);
    command("/misc-formats/wasm-test", "-1");
    puts("binfmt-misc: preserve-argv0 interpreter contract pass");
    fflush(stdout);
    registration("O");
    run("open", 0);
    command("/misc-formats/wasm-test", "-1");
    puts("binfmt-misc: AT_EXECFD binary identity, bytes and interpreter credentials pass");
    fflush(stdout);
    registration("C");
    run("creds", 0);
    command("/misc-formats/wasm-test", "-1");
    puts("binfmt-misc: binary credentials and secure execution with implied open pass");
    fflush(stdout);
    registration("F");
    require(rename("/misc-helper", "/misc-helper-moved") == 0, "rename pinned interpreter");
    run("fixed", 0);
    command("/misc-formats/wasm-test", "-1");
    run("removed", ENOEXEC);
    require(rename("/misc-helper-moved", "/misc-helper") == 0 &&
            unlink("/misc-payload") == 0 && umount("/misc-formats") == 0 &&
            rmdir("/misc-formats") == 0, "handler references and mount cleanup");
    puts("binfmt-misc: pinned interpreter after rename, unregister and mount cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
