// SPDX-License-Identifier: MIT
/* No libc/startup: observe the actual architecture TP before it is replaced. */
__attribute__((import_module("linux"), import_name("get_thread_area")))
extern __UINTPTR_TYPE__ thread_pointer(void);
__attribute__((import_module("linux"), import_name("syscall")))
extern long kernel_call(long, long, long, long, long, long, long);

__attribute__((export_name("_start"), noreturn)) void _start(void)
{
    long status = thread_pointer() ? 31 : 0;
    kernel_call(94, status, 0, 0, 0, 0, 0); /* Linux exit_group */
    __builtin_trap();
}
