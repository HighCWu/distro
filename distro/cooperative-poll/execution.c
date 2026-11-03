// SPDX-License-Identifier: MIT
// Compiler execution support, not libc or an application API. This object is
// experimental until the matching kernel interrupt-return bridge is accepted.

__attribute__((import_module("linux_user_poll_v1"), import_name("checkpoint")))
extern int user_poll_checkpoint(void);

static _Thread_local unsigned poll_budget = 4096;

__attribute__((visibility("hidden"), no_sanitize("coverage")))
void __sanitizer_cov_trace_pc(void)
{
    // Instrumented constructors must not access native TLS before it exists.
    if (!__builtin_wasm_tls_base()) return;
    if (--poll_budget) return;
    // Reset before entering Linux: a signal handler can leave non-locally.
    poll_budget = 4096;
    if (user_poll_checkpoint()) __builtin_trap();
}

__attribute__((export_name("__wasm_user_poll_abi"), no_sanitize("coverage")))
int __wasm_user_poll_abi(void)
{
    return 1;
}
