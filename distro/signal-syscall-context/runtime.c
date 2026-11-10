// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

#if !defined(__wasm__)
#error "signal-syscall-context is an internal Wasm ABI consumer"
#endif

__attribute__((import_module("linux_signal_syscall_v1"), import_name("abi")))
extern int signal_syscall_abi(void);
__attribute__((import_module("linux_signal_syscall_v1"), import_name("frame")))
extern int signal_syscall_frame(void *State);
__attribute__((import_module("linux_signal_syscall_v1"), import_name("finish")))
extern int signal_syscall_finish(const void *State);

struct signal_syscall_state {
    long result;
    unsigned long flags;
};

_Static_assert(sizeof(long) == sizeof(void *), "signal syscall state uses the target machine word");
_Static_assert(sizeof(struct signal_syscall_state) == 2 * sizeof(long), "signal syscall state is exactly two machine words");
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "signal test acknowledgements must be lock-free in handlers");

enum {
    SIGNAL_STATE_VALID = 1,
    SIGNAL_STATE_RESTART = 2,
    MODE_CANCEL_WITH_ERRNO = 1,
    MODE_NO_RESTART = 2,
    MODE_RESTART_AND_WRITE = 3,
};

static volatile sig_atomic_t CurrentMode;
static volatile sig_atomic_t HandlerFailure;
static volatile sig_atomic_t NestedFailure;
static int PipeWriteFD = -1;
static _Atomic int ReadArmed;
static _Atomic int ReadDone;
static _Atomic int HandlerAck;
static _Atomic int SenderStatus;

static void record_handler_failure(sig_atomic_t code)
{
    if (!HandlerFailure) HandlerFailure = code;
}

static void fail_active_handler(sig_atomic_t code)
{
    record_handler_failure(code);
    atomic_store_explicit(&HandlerAck, 1, memory_order_release);
    const char WakeByte = '!';
    if (PipeWriteFD >= 0) (void)write(PipeWriteFD, &WakeByte, sizeof(WakeByte));
}

static int state_matches(const struct signal_syscall_state *State, long Result, unsigned long Flags)
{
    return State->result == Result && State->flags == Flags;
}

static int snapshot_matches(long Result, unsigned long Flags)
{
    struct signal_syscall_state State = { 0, 0 };
    return signal_syscall_frame(&State) == 0 && state_matches(&State, Result, Flags);
}

static void nested_handler(int Signal)
{
    if (Signal != SIGUSR2) {
        NestedFailure = 1;
        return;
    }

    struct signal_syscall_state Nested = { 0, 0 };
    const int Status = signal_syscall_frame(&Nested);
    if (Status != 0 || Nested.flags != SIGNAL_STATE_VALID || signal_syscall_finish(&Nested) != 0) {
        NestedFailure = 2;
    }
}

static void signal_handler(int Signal)
{
    if (Signal != SIGUSR1) {
        fail_active_handler(1);
        return;
    }
    if (atomic_load_explicit(&HandlerAck, memory_order_acquire)) return;

    struct signal_syscall_state State = { 0, 0 };
    const unsigned long ExpectedFlags = CurrentMode == MODE_NO_RESTART ? SIGNAL_STATE_VALID :
                                                                         SIGNAL_STATE_VALID | SIGNAL_STATE_RESTART;
    // A repeated signal can arrive just before the read enters the kernel.
    // Ignore that notification until the active read has the expected frame;
    // the sender retries until this handler acknowledges a real hit.
    if (signal_syscall_frame(&State) != 0 || !state_matches(&State, -EINTR, ExpectedFlags)) {
        return;
    }

    if (CurrentMode == MODE_CANCEL_WITH_ERRNO) {
        struct signal_syscall_state Invalid = State;
        Invalid.flags |= 4;
        if (signal_syscall_finish(&Invalid) != -EINVAL || !snapshot_matches(-EINTR, SIGNAL_STATE_VALID | SIGNAL_STATE_RESTART)) {
            fail_active_handler(3);
            return;
        }

        Invalid = State;
        Invalid.result = -EACCES;
        if (signal_syscall_finish(&Invalid) != -EINVAL || !snapshot_matches(-EINTR, SIGNAL_STATE_VALID | SIGNAL_STATE_RESTART)) {
            fail_active_handler(4);
            return;
        }

        State.flags &= ~SIGNAL_STATE_RESTART;
        State.result = -EACCES;
        if (signal_syscall_finish(&State) != 0) {
            fail_active_handler(5);
            return;
        }
        atomic_store_explicit(&HandlerAck, 1, memory_order_release);
        return;
    }

    if (CurrentMode == MODE_NO_RESTART) {
        // A handler installed without SA_RESTART must see VALID only. It may
        // neither create a restart nor clear the kernel-owned VALID bit.
        if (!snapshot_matches(-EINTR, SIGNAL_STATE_VALID)) {
            fail_active_handler(6);
            return;
        }
        struct signal_syscall_state Invalid = { -EINTR, SIGNAL_STATE_VALID | SIGNAL_STATE_RESTART };
        if (signal_syscall_finish(&Invalid) != -EINVAL || !snapshot_matches(-EINTR, SIGNAL_STATE_VALID)) {
            fail_active_handler(7);
            return;
        }
        Invalid.flags = 0;
        if (signal_syscall_finish(&Invalid) != -EINVAL || !snapshot_matches(-EINTR, SIGNAL_STATE_VALID)) {
            fail_active_handler(8);
            return;
        }
        if (signal_syscall_finish(&State) != 0) {
            fail_active_handler(9);
            return;
        }
        atomic_store_explicit(&HandlerAck, 1, memory_order_release);
        return;
    }

    if (CurrentMode == MODE_RESTART_AND_WRITE) {
        if (raise(SIGUSR2) != 0 || NestedFailure != 0 ||
            !snapshot_matches(-EINTR, SIGNAL_STATE_VALID | SIGNAL_STATE_RESTART) ||
            signal_syscall_finish(&State) != 0) {
            fail_active_handler(10);
            return;
        }
        const char Byte = 'R';
        if (write(PipeWriteFD, &Byte, sizeof(Byte)) != (ssize_t)sizeof(Byte)) {
            fail_active_handler(11);
            return;
        }
        atomic_store_explicit(&HandlerAck, 1, memory_order_release);
        return;
    }

    fail_active_handler(12);
}

struct signal_sender_request {
    pthread_t Target;
    int WriteFD;
};

static void *signal_sender(void *Pointer)
{
    const struct signal_sender_request *Request = Pointer;
    int Armed = 0;
    for (unsigned Attempt = 0; Attempt < 500; ++Attempt) {
        if (atomic_load_explicit(&ReadArmed, memory_order_acquire)) {
            Armed = 1;
            break;
        }
        struct timespec Delay = { .tv_sec = 0, .tv_nsec = 1000000 };
        if (nanosleep(&Delay, NULL) != 0 && errno != EINTR) break;
    }

    int Status = 0;
    if (!Armed) {
        Status = ETIMEDOUT;
    } else {
        for (unsigned Attempt = 0; Attempt < 250; ++Attempt) {
            if (atomic_load_explicit(&HandlerAck, memory_order_acquire) ||
                atomic_load_explicit(&ReadDone, memory_order_acquire)) {
                break;
            }
            Status = pthread_kill(Request->Target, SIGUSR1);
            if (Status != 0) break;
            atomic_store_explicit(&SenderStatus, 0, memory_order_release);
            struct timespec Delay = { .tv_sec = 0, .tv_nsec = 20000000 };
            if (nanosleep(&Delay, NULL) != 0 && errno != EINTR) {
                Status = errno;
                break;
            }
        }
        if (Status == 0 && !atomic_load_explicit(&HandlerAck, memory_order_acquire) &&
            !atomic_load_explicit(&ReadDone, memory_order_acquire)) {
            Status = ETIMEDOUT;
        }
    }
    atomic_store_explicit(&SenderStatus, Status, memory_order_release);
    if (Status != 0) {
        const char WakeByte = '!';
        (void)write(Request->WriteFD, &WakeByte, sizeof(WakeByte));
    }
    return NULL;
}

static void require(int Condition, const char *What)
{
    if (Condition) return;
    printf("::vm-test::fail: signal syscall context: %s errno=%d\n", What, errno);
    fflush(stdout);
    _Exit(1);
}

static void run_read_case(sig_atomic_t Mode, int SignalFlags, ssize_t ExpectedResult, int ExpectedErrno, char ExpectedByte)
{
    int PipeFDs[2];
    require(pipe(PipeFDs) == 0, "create blocking-read pipe");

    struct sigaction Action = { 0 };
    Action.sa_handler = signal_handler;
    Action.sa_flags = SignalFlags;
    sigemptyset(&Action.sa_mask);
    require(sigaction(SIGUSR1, &Action, NULL) == 0, "install syscall-context handler");

    struct sigaction NestedAction = { 0 };
    NestedAction.sa_handler = nested_handler;
    sigemptyset(&NestedAction.sa_mask);
    require(sigaction(SIGUSR2, &NestedAction, NULL) == 0, "install nested notification handler");

    CurrentMode = Mode;
    HandlerFailure = 0;
    NestedFailure = 0;
    PipeWriteFD = PipeFDs[1];
    atomic_store_explicit(&ReadArmed, 0, memory_order_relaxed);
    atomic_store_explicit(&ReadDone, 0, memory_order_relaxed);
    atomic_store_explicit(&HandlerAck, 0, memory_order_relaxed);
    atomic_store_explicit(&SenderStatus, -1, memory_order_relaxed);

    struct signal_sender_request Request = { pthread_self(), PipeFDs[1] };
    pthread_t Sender;
    require(pthread_create(&Sender, NULL, signal_sender, (void *)&Request) == 0, "create independent signal sender");

    char Byte = 0;
    errno = 0;
    atomic_store_explicit(&ReadArmed, 1, memory_order_release);
    const ssize_t Result = read(PipeFDs[0], &Byte, sizeof(Byte));
    const int ReadErrno = errno;
    atomic_store_explicit(&ReadDone, 1, memory_order_release);

    require(pthread_join(Sender, NULL) == 0, "join signal sender");
    require(atomic_load_explicit(&SenderStatus, memory_order_acquire) == 0, "sender delivered signal after read was armed");
    require(atomic_load_explicit(&HandlerAck, memory_order_acquire) == 1, "handler acknowledged the active blocking read");
    require(HandlerFailure == 0 && NestedFailure == 0, "handler snapshot, validation and finish state");
    if (ExpectedResult < 0) {
        require(Result == -1 && ReadErrno == ExpectedErrno, "read returns requested signal-frame errno");
    } else {
        require(Result == ExpectedResult && Byte == ExpectedByte, "SA_RESTART resumes read and receives handler byte");
    }

    PipeWriteFD = -1;
    require(close(PipeFDs[0]) == 0 && close(PipeFDs[1]) == 0, "close blocking-read pipe");
}

int main(void)
{
    alarm(30);
    require(signal_syscall_abi() == 1, "kernel advertises signal syscall context ABI version 1");

    struct signal_syscall_state Inactive = { 0x1234, 0x5678 };
    require(signal_syscall_frame(&Inactive) == -EINVAL, "frame import rejects an inactive context");
    require(signal_syscall_finish(&Inactive) == -EINVAL, "finish import rejects an inactive context and forged VALID state");

    run_read_case(MODE_CANCEL_WITH_ERRNO, SA_RESTART, -1, EACCES, 0);
    puts("signal syscall context: invalid flags preserve restart state and cancellation returns custom errno pass");

    run_read_case(MODE_NO_RESTART, 0, -1, EINTR, 0);
    puts("signal syscall context: non-restarting frame cannot start restart or forge VALID pass");

    run_read_case(MODE_RESTART_AND_WRITE, SA_RESTART, 1, 0, 'R');
    puts("signal syscall context: nested snapshot stays independent and SA_RESTART resumes read pass");

    alarm(0);
    puts("::vm-test::pass");
    fflush(stdout);
    for (;;) pause();
}
