// SPDX-License-Identifier: MIT
// Small side-module fixture: Linux can deliver a pending signal only when this
// otherwise pure loop explicitly reaches the process owner's checkpoint.
#include <stdint.h>

#if __SIZEOF_POINTER__ == 8
#define POLL_WORD "i64"
#else
#define POLL_WORD "i32"
#endif

__asm__(".globaltype __wasm_user_poll_tp, " POLL_WORD "\n"
        ".import_module __wasm_user_poll_tp, linux_user_poll_v2\n"
        ".import_name __wasm_user_poll_tp, thread_pointer\n");

__attribute__((import_module("linux_user_poll_v2"), import_name("checkpoint")))
extern int user_poll_checkpoint(void);

static volatile uintptr_t observed_thread_pointer;
int poll_library_constructor_count;
int poll_library_constructor_result;

__attribute__((constructor))
static void poll_constructor(void)
{
    poll_library_constructor_count++;
    poll_library_constructor_result = user_poll_checkpoint();
}

uintptr_t poll_library_thread_pointer(void)
{
    return observed_thread_pointer;
}

__attribute__((visibility("default"), no_sanitize("coverage")))
uint32_t poll_library_spin(uint64_t iterations)
{
    volatile uint64_t state = 0x9e3779b97f4a7c15ULL;
    for (uint64_t index = 0; index < iterations; index++) {
        state = (state ^ (state >> 11)) * 0xd6e8feb86659fd93ULL + index;
        if ((index & 0x3ff) == 0) {
            uintptr_t thread_pointer;
            __asm__ volatile("global.get __wasm_user_poll_tp\nlocal.set %0"
                             : "=r"(thread_pointer));
            observed_thread_pointer = thread_pointer;
            const int result = user_poll_checkpoint();
            if (result) return (uint32_t)result;
        }
    }
    return 0;
}
