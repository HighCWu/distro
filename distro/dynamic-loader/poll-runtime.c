// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#if __SIZEOF_POINTER__ == 8
#define POLL_WORD "i64"
#else
#define POLL_WORD "i32"
#endif
__asm__(".globaltype __wasm_user_poll_tp, " POLL_WORD "\n"
        ".import_module __wasm_user_poll_tp, linux_user_poll_v2\n"
        ".import_name __wasm_user_poll_tp, thread_pointer\n"
        ".globaltype __stack_pointer, " POLL_WORD "\n"
        ".globaltype __tls_base, " POLL_WORD "\n");

__attribute__((import_module("linux_user_poll_v2"), import_name("checkpoint")))
extern int user_poll_checkpoint(void);
__attribute__((import_module("linux"), import_name("get_thread_area")))
extern uintptr_t process_thread_pointer(void);

__attribute__((export_name("__wasm_user_poll_abi")))
int __wasm_user_poll_abi(void) { return 2; }

static volatile sig_atomic_t alarm_seen;
static _Thread_local volatile uint32_t tls_guard = 0x12345678;

static void require(int condition, const char *message)
{
    if (condition) return;
    fprintf(stderr, "::vm-test::fail: side poll: %s errno=%d\n", message, errno);
    exit(1);
}

static void on_alarm(int signal_number)
{
    (void)signal_number;
    alarm_seen = 1;
}

static uintptr_t stack_pointer(void)
{
    uintptr_t result;
    __asm__ volatile("global.get __stack_pointer\nlocal.set %0" : "=r"(result));
    return result;
}

static uintptr_t tls_base(void)
{
    uintptr_t result;
    __asm__ volatile("global.get __tls_base\nlocal.set %0" : "=r"(result));
    return result;
}

static uintptr_t published_pointer(void)
{
    uintptr_t result;
    __asm__ volatile("global.get __wasm_user_poll_tp\nlocal.set %0" : "=r"(result));
    return result;
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(user_poll_checkpoint() == 0, "initial main checkpoint");
    void *handle = dlopen("/plugins/poll-library.so", RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        const char *error = dlerror();
        fprintf(stderr, "::vm-test::fail: side poll dlopen: %s\n", error ? error : "unknown");
        return 1;
    }
    uint32_t (*spin)(uint64_t) = (uint32_t (*)(uint64_t))dlsym(handle, "poll_library_spin");
    uintptr_t (*observed_pointer)(void) = (uintptr_t (*)(void))dlsym(handle, "poll_library_thread_pointer");
    int *constructor_count = dlsym(handle, "poll_library_constructor_count");
    int *constructor_result = dlsym(handle, "poll_library_constructor_result");
    require(spin && observed_pointer && constructor_count && constructor_result, "resolve library exports");
    require(*constructor_count == 1 && *constructor_result == 0, "constructor checkpoint is deferred safely");

    struct sigaction action = {.sa_handler = on_alarm};
    struct sigaction previous;
    sigemptyset(&action.sa_mask);
    require(sigaction(SIGALRM, &action, &previous) == 0, "install SIGALRM handler");
    const uintptr_t expected_pointer = process_thread_pointer();
    require(expected_pointer != 0, "process has a native thread pointer");
    require(published_pointer() == expected_pointer, "owner publishes its thread-pointer Global");
    tls_guard = 0xabcdef01;
    const uintptr_t saved_stack = stack_pointer();
    const uintptr_t saved_tls = tls_base();
    alarm_seen = 0;
    errno = EDOM;
    require(alarm(1) == 0, "arm SIGALRM");
    uint32_t chunks = 0;
    uint32_t result = 0;
    while (!alarm_seen && chunks < 4096) {
        result = spin(UINT64_C(1) << 20);
        if (result) break;
        chunks++;
    }
    const int preserved = errno == EDOM && tls_guard == 0xabcdef01 &&
                          stack_pointer() == saved_stack && tls_base() == saved_tls;
    const int delivered = alarm_seen;
    alarm(0);
    require(result == 0 && chunks != 0, "side checkpoints return successfully");
    require(delivered, "SIGALRM arrives during the side-module loop");
    require(preserved, "polling preserves main errno, TLS and stack globals");
    require(observed_pointer() == expected_pointer, "side module shares the owner's thread-pointer Global");
    require(sigaction(SIGALRM, &previous, NULL) == 0, "restore SIGALRM handler");
    require(dlclose(handle) == 0, "close library");
    puts("dynamic side poll: constructor deferral, signal delivery and owner TLS/stack pass");
    puts("::vm-test::pass");
    for (;;) pause();
}
