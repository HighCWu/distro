/* SPDX-License-Identifier: MIT */
#include <stdio.h>
#include <stdlib.h>
#ifdef __wasm__
#include <sched.h>
#endif

#ifndef HAVE_MALLOC
#error configure did not find malloc
#endif
#ifdef HAVE_LINUX_WASM_SDK_MISSING_FUNCTION
#error configure accepted a missing function
#endif

int main(void)
{
    volatile unsigned char *buffer = malloc(64);
    if (!buffer) {
        puts("::vm-test::fail: Autoconf consumer allocation");
        return EXIT_FAILURE;
    }
    for (unsigned int i = 0; i < 64; ++i)
        buffer[i] = (unsigned char)i;
    for (unsigned int i = 0; i < 64; ++i) {
        if (buffer[i] != i) {
            free((void *)buffer);
            puts("::vm-test::fail: Autoconf consumer memory check");
            return EXIT_FAILURE;
        }
    }
    free((void *)buffer);
    puts("SDK Autoconf: cross configuration and allocation verified");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return EXIT_SUCCESS;
#endif
}
