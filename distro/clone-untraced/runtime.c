// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#if !defined(__wasm__) && !defined(__x86_64__)
#error "Native reference requires the x86-64 clone register layout"
#endif
#include <errno.h>
#include <linux/sched.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "::vm-test::fail: clone untraced: %s errno=%d\n", what, errno);
    exit(1);
}
static long trace(int request, pid_t pid, uintptr_t data)
{
    return ptrace(request, pid, (void *)0, (void *)data);
}
static pid_t create(int legacy, unsigned long flags)
{
#ifdef DROP_UNTRACED
    flags &= ~CLONE_UNTRACED;
#endif
#ifdef DROP_PTRACE
    flags &= ~CLONE_PTRACE;
#endif
    if (legacy)
        return syscall(SYS_clone, (long)(flags | SIGCHLD), 0L, 0L, 0L, 0L, 0L);
    struct clone_args args = { .flags = flags, .exit_signal = SIGCHLD };
    return syscall(SYS_clone3, (long)(uintptr_t)&args, (long)sizeof args, 0L, 0L, 0L, 0L);
}
static void scenario(int legacy, int untraced)
{
    int report[2], status;
    require(pipe(report) == 0, "create child identity pipe");
    pid_t caller = fork();
    require(caller >= 0, "create trace caller");
    if (!caller) {
        close(report[0]);
        require(trace(PTRACE_TRACEME, 0, 0) == 0, "trace caller");
        require(syscall(SYS_tkill, (long)getpid(), (long)SIGSTOP, 0L, 0L, 0L, 0L) == 0,
                "stop before clone");
        pid_t child = create(legacy, untraced ? CLONE_UNTRACED : 0);
        require(child >= 0, "clone under active fork tracing");
        if (!child) _exit(37);
        require(write(report[1], &child, sizeof child) == sizeof child, "report actual clone PID");
        require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 37,
                "caller remains real parent and reaps clone child");
        errno = 0;
        require(waitpid(child, &status, __WALL | WNOHANG) == -1 && errno == ECHILD,
                "clone child is reaped exactly once");
        _exit(38);
    }
    close(report[1]);
    require(waitpid(caller, &status, 0) == caller && WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP,
            "initial caller signal stop");
    require(trace(PTRACE_SETOPTIONS, caller, PTRACE_O_TRACEFORK | PTRACE_O_EXITKILL) == 0 &&
            trace(PTRACE_CONT, caller, 0) == 0, "enable forced fork tracing");
    pid_t event_child = 0;
    require(waitpid(caller, &status, 0) == caller, "wait caller event or completion");
    if (!untraced) {
        unsigned long event = 0;
        require(WIFSTOPPED(status) && WSTOPSIG(status) == SIGTRAP &&
                (unsigned)status >> 16 == PTRACE_EVENT_FORK, "ordinary clone produces fork event");
        require(trace(PTRACE_GETEVENTMSG, caller, (uintptr_t)&event) == 0 && event > 0,
                "fork event carries child PID");
        event_child = (pid_t)event;
        require(event_child > 0 && (unsigned long)event_child == event && event_child != caller,
                "event child PID fits pid_t");
        pid_t waited = waitpid(event_child, &status, __WALL);
        if (waited != event_child || !WIFSTOPPED(status))
            fprintf(stderr, "clone untraced: initial child wait returned %d expected %d status=%#x errno=%d\n",
                    waited, event_child, status, errno);
        require(waited == event_child && WIFSTOPPED(status),
                "ordinary child inherits ptrace stop");
        require(trace(PTRACE_DETACH, event_child, 0) == 0 && trace(PTRACE_CONT, caller, 0) == 0,
                "release traced child and caller");
        require(waitpid(caller, &status, 0) == caller, "caller finishes after event");
    }
    // A traced caller can also stop for its child's SIGCHLD. Forward only
    // that signal; a fork event must never be mistaken for completion.
    while (WIFSTOPPED(status) && WSTOPSIG(status) == SIGCHLD && !((unsigned)status >> 16)) {
        require(trace(PTRACE_CONT, caller, SIGCHLD) == 0, "forward child exit notification");
        require(waitpid(caller, &status, 0) == caller, "caller after SIGCHLD");
    }
    require(WIFEXITED(status) && WEXITSTATUS(status) == 38,
            untraced ? "UNTRACED suppresses forced child tracing" : "ordinary caller completes");
    pid_t reported = 0;
    require(read(report[0], &reported, sizeof reported) == sizeof reported && reported > 0,
            "read actual clone PID");
    require(untraced || reported == event_child, "event identifies actual child");
    require(close(report[0]) == 0, "close report pipe");
    errno = 0;
    require(waitpid(-1, &status, __WALL | WNOHANG) == -1 && errno == ECHILD,
            "no traced or ordinary children remain");
}
static void explicit_trace(int legacy, int untraced)
{
    int report[2], status;
    require(pipe(report) == 0, "explicit tracing identity pipe");
    pid_t caller = fork();
    require(caller >= 0, "explicit tracing caller");
    if (!caller) {
        close(report[0]);
        sigset_t blocked;
        sigemptyset(&blocked); sigaddset(&blocked, SIGCHLD);
        require(sigprocmask(SIG_BLOCK, &blocked, NULL) == 0, "block caller exit notification during handshake");
        require(trace(PTRACE_TRACEME, 0, 0) == 0 &&
                syscall(SYS_tkill, (long)getpid(), (long)SIGSTOP, 0L, 0L, 0L, 0L) == 0,
                "explicit caller initial stop");
        pid_t child = create(legacy, CLONE_PTRACE | (untraced ? CLONE_UNTRACED : 0));
        require(child >= 0, "explicit ptrace clone");
        if (!child) _exit(41);
        require(write(report[1], &child, sizeof child) == sizeof child, "publish explicit child PID");
        require(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 41,
                "caller reaps explicit child after tracer detaches");
        _exit(42);
    }
    close(report[1]);
    require(waitpid(caller, &status, 0) == caller && WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP,
            "explicit caller stopped before clone");
    // No TRACEFORK option: inheritance must come from the caller's flag.
    require(trace(PTRACE_SETOPTIONS, caller, PTRACE_O_EXITKILL) == 0 &&
            trace(PTRACE_CONT, caller, 0) == 0, "continue without forced fork tracing");
    struct pollfd ready = { .fd = report[0], .events = POLLIN };
    require(poll(&ready, 1, 5000) == 1 && (ready.revents & POLLIN), "bounded explicit child report");
    pid_t child;
    require(read(report[0], &child, sizeof child) == sizeof child && child > 0 && child != caller,
            "read explicit child identity");
    pid_t waited = waitpid(child, &status, __WALL);
    if (waited != child || !WIFSTOPPED(status))
        fprintf(stderr, "clone untraced: explicit child wait returned %d expected %d status=%#x errno=%d\n",
                waited, child, status, errno);
    require(waited == child && WIFSTOPPED(status) && WSTOPSIG(status) == SIGSTOP &&
            !((unsigned)status >> 16), "explicit PTRACE child inherits SIGSTOP without forced event");
    require(trace(PTRACE_DETACH, child, 0) == 0, "detach explicitly inherited child");
    require(waitpid(caller, &status, 0) == caller && WIFEXITED(status) && WEXITSTATUS(status) == 42,
            "explicit caller completes after own reaping");
    require(close(report[0]) == 0, "close explicit tracing report");
    errno = 0;
    require(waitpid(-1, &status, __WALL | WNOHANG) == -1 && errno == ECHILD, "explicit tracing cleanup");
}
int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
#ifdef __wasm__
    scenario(0, 0);
    scenario(0, 1);
    puts("clone untraced: native clone3 reports ordinary fork and suppresses UNTRACED event pass");
#endif
    scenario(1, 0);
    scenario(1, 1);
    puts("clone untraced: legacy clone reports ordinary fork and suppresses UNTRACED event pass");
#ifdef __wasm__
    explicit_trace(0, 0);
    explicit_trace(0, 1);
    puts("clone untraced: native explicit PTRACE inherits tracing with and without UNTRACED pass");
#endif
    explicit_trace(1, 0);
    explicit_trace(1, 1);
    puts("clone untraced: legacy explicit PTRACE inherits tracing with and without UNTRACED pass");
    scenario(1, 0);
    puts("clone untraced: later ordinary tracing and process cleanup recover pass");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#endif
}
