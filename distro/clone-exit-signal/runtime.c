// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t notifications;
static volatile sig_atomic_t child_notifications;
static volatile int private_value = 61;
static int use_legacy;
static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: clone exit signal: %s errno=%d\n", what, errno);
    exit(1);
}
static void notified(int signal)
{
    if (signal == SIGUSR1) notifications++;
    if (signal == SIGCHLD) child_notifications++;
}
static pid_t create(int signal, int *fd)
{
#ifdef __wasm__
    if (use_legacy)
        return syscall(SYS_clone, (long)(CLONE_PIDFD | signal), 0L,
                       (long)(uintptr_t)fd, 0L, 0L, 0L);
    struct clone_args args = { .flags = CLONE_PIDFD, .pidfd = (uintptr_t)fd,
                              .exit_signal = signal };
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args, 0L, 0L, 0L, 0L);
#elif defined(__x86_64__)
    /* Native reference covers Linux notification/wait semantics through clone;
     * sandboxed hosts commonly deny clone3 before kernel argument validation. */
    return syscall(SYS_clone, (long)(CLONE_PIDFD | signal), 0L,
                   (long)(uintptr_t)fd, 0L, 0L, 0L);
#else
#error "Native reference requires the x86-64 clone register layout"
#endif
}
static void scenario(int signal)
{
    int fd = -1;
    pid_t child = create(signal, &fd);
    require(child >= 0, "create child with selected exit notification");
    if (!child) { private_value = 99; _exit(37); }
    int fd_flags = fcntl(fd, F_GETFD);
    require(fd >= 0 && fd_flags >= 0 && (fd_flags & FD_CLOEXEC), "atomic CLOEXEC PIDFD");
    struct pollfd event = { .fd = fd, .events = POLLIN };
    int ready;
    do { ready = poll(&event, 1, 5000); } while (ready < 0 && errno == EINTR);
    require(ready == 1 && (event.revents & POLLIN), "PIDFD reports child exit");
    int status;
    if (signal != SIGCHLD) {
        errno = 0;
        require(waitpid(child, &status, WNOHANG) == -1 && errno == ECHILD,
                "ordinary wait excludes a non-SIGCHLD child");
    }
    int options = signal == SIGCHLD ? 0 : __WCLONE;
    pid_t result;
    do { result = waitpid(child, &status, options); } while (result < 0 && errno == EINTR);
    require(result == child && WIFEXITED(status) && WEXITSTATUS(status) == 37,
            "selected Linux wait class reaps exact child");
    errno = 0;
    require(waitpid(child, &status, options | WNOHANG) == -1 && errno == ECHILD, "single reaping");
    require(close(fd) == 0 && private_value == 61, "PIDFD cleanup and independent user memory");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    struct sigaction old, old_child, action = { .sa_handler = notified };
    sigemptyset(&action.sa_mask);
    require(sigaction(SIGUSR1, &action, &old) == 0, "install exit notification handler");
    require(sigaction(SIGCHLD, &action, &old_child) == 0, "observe standard child notifications");
    for (int phase = 0; phase <
#ifdef __wasm__
         2
#else
         1
#endif
         ; phase++) {
    use_legacy = phase;
    notifications = child_notifications = 0;
    scenario(0);
    require(notifications == 0 && child_notifications == 0, "zero exit signal sends neither notification");
    puts(use_legacy ? "legacy clone exit signal: zero notification preserves PIDFD exit and WCLONE reaping pass" :
         "clone exit signal: zero notification preserves PIDFD exit and WCLONE reaping pass");
    scenario(SIGUSR1);
    require(notifications == 1 && child_notifications == 0, "kernel delivers exactly one selected exit signal");
    puts(use_legacy ? "legacy clone exit signal: selected notification reaches parent and ordinary wait excludes child pass" :
         "clone exit signal: selected notification reaches parent and ordinary wait excludes child pass");
    scenario(SIGCHLD);
    require(notifications == 1 && child_notifications == 1, "later SIGCHLD does not reuse prior signal");
#ifdef __wasm__
    /* clone3 validates exit_signal independently; legacy clone on the native
     * reference kernel does not provide the same validation contract. */
    if (!use_legacy) {
        int fd = -9;
        errno = 0;
        pid_t rejected = create(65, &fd);
        if (!rejected) _exit(99);
        require(rejected == -1 && errno == EINVAL && fd == -9, "invalid signal leaves PIDFD unchanged");
    }
#endif
    int status;
    errno = 0;
    require(waitpid(-1, &status, __WALL | WNOHANG) == -1 && errno == ECHILD,
            "all child wait classes empty after rejection");
    pid_t recovered = fork();
    require(recovered >= 0, "ordinary fork after selected signal requests");
    if (!recovered) _exit(42);
    pid_t waited;
    do { waited = waitpid(recovered, &status, 0); } while (waited < 0 && errno == EINTR);
    require(waited == recovered && WIFEXITED(status) && WEXITSTATUS(status) == 42 &&
            notifications == 1 && child_notifications == 2,
            "ordinary fork resets SIGCHLD and recovers exact wait");
    puts(use_legacy ? "legacy clone exit signal: later SIGCHLD wait and request cleanup recover pass" :
         "clone exit signal: later SIGCHLD wait and request cleanup recover pass");
    }
    require(sigaction(SIGUSR1, &old, NULL) == 0, "restore parent handler");
    require(sigaction(SIGCHLD, &old_child, NULL) == 0, "restore standard child handler");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#else
    return 0;
#endif
}
