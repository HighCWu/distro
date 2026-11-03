// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#if !defined(__wasm__) && !defined(__x86_64__)
#error "Native reference requires the x86-64 clone register layout"
#endif
#include <errno.h>
#include <linux/sched.h>
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
static pid_t create(int legacy, int untraced)
{
    unsigned long flags = untraced ? CLONE_UNTRACED : 0;
#ifdef DROP_UNTRACED
    flags = 0; // Negative control must detect a silently dropped flag.
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
        pid_t child = create(legacy, untraced);
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
    scenario(1, 0);
    puts("clone untraced: later ordinary tracing and process cleanup recover pass");
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#endif
}
