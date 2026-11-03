// SPDX-License-Identifier: MIT
// Compiler execution support, not libc or an application API. This object is
// experimental until the matching kernel interrupt-return bridge is accepted.

#ifdef WASM_POLL_THREAD_GLOBAL
#define POLL_MODULE "linux_user_poll_v2"
#if __SIZEOF_POINTER__ == 8
#define POLL_WORD "i64"
#else
#define POLL_WORD "i32"
#endif
__asm__(".globaltype __wasm_user_poll_tp, " POLL_WORD "\n"
        ".import_module __wasm_user_poll_tp, linux_user_poll_v2\n"
        ".import_name __wasm_user_poll_tp, thread_pointer\n");
static _Thread_local __UINTPTR_TYPE__ poll_owner;
#else
#define POLL_MODULE "linux_user_poll_v1"
#endif

__attribute__((import_module(POLL_MODULE), import_name("checkpoint")))
extern int user_poll_checkpoint(void);

static _Thread_local unsigned poll_budget = 4096;

__attribute__((visibility("hidden"), no_sanitize("coverage")))
void __sanitizer_cov_trace_pc(void)
{
    // Instrumented constructors must not access native TLS before it exists.
    if (!__builtin_wasm_tls_base()) return;
#ifdef WASM_POLL_THREAD_GLOBAL
    __UINTPTR_TYPE__ thread;
    __asm__ volatile("global.get __wasm_user_poll_tp\nlocal.set %0" : "=r"(thread));
    if (!thread) return;
    // Early clone startup can still point at the parent's native TLS. Its
    // owner is established before instrumented libc creates the child.
    if (poll_owner != thread) {
        if (poll_owner) return;
        // Claim once, before publishing the TLS block through clone. An early
        // child may read this word concurrently with its owner's checkpoints.
        poll_owner = thread;
    }
#endif
    if (--poll_budget) return;
    // Reset before entering Linux: a signal handler can leave non-locally.
    poll_budget = 4096;
    if (user_poll_checkpoint()) __builtin_trap();
}

__attribute__((export_name("__wasm_user_poll_abi"), no_sanitize("coverage")))
int __wasm_user_poll_abi(void)
{
#ifdef WASM_POLL_THREAD_GLOBAL
    return 2;
#else
    return 1;
#endif
}
