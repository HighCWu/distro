// SPDX-License-Identifier: MIT
#define _GNU_SOURCE

#include <errno.h>
#include <linux/landlock.h>
#include <sched.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static int check_varargs(int count, void *expected_pointer, ...)
{
    va_list args;
    va_list copied;
    va_start(args, expected_pointer);
    va_copy(copied, args);

    int values_match = 1;
    int copied_values_match = 1;
    values_match &= va_arg(args, int) == 17;
    values_match &= va_arg(args, long) == 1234567890123L;
    values_match &= va_arg(args, double) == 4.5;
    values_match &= va_arg(args, void *) == expected_pointer;
    copied_values_match &= va_arg(copied, int) == 17;
    copied_values_match &= va_arg(copied, long) == 1234567890123L;
    copied_values_match &= va_arg(copied, double) == 4.5;
    copied_values_match &= va_arg(copied, void *) == expected_pointer;

    va_end(copied);
    va_end(args);
    return count == 4 && values_match && copied_values_match;
}

static int run_abi_checks(void)
{
    int marker = 0;
    void *pointer = &marker;
    char pointer_text[32];
    char expected[96];
    char actual[96];

    if (!check_varargs(4, pointer, 17, 1234567890123L, 4.5, pointer))
        return 1;

    errno = 0;
    int pointer_length = snprintf(pointer_text, sizeof(pointer_text), "%p", pointer);
    if (pointer_length < 1 || pointer_length >= (int)sizeof(pointer_text) || errno != 0)
        return 2;

    int expected_length = snprintf(expected, sizeof(expected), "17/1234567890123/4.5/%s", pointer_text);
    if (expected_length < 0 || expected_length >= (int)sizeof(expected))
        return 3;

    errno = 0;
    int actual_length = snprintf(
        actual, sizeof(actual), "%d/%ld/%.1f/%p", 17, 1234567890123L, 4.5, pointer);
    if (actual_length != expected_length || strcmp(actual, expected) != 0 || errno != 0)
        return 4;

    errno = 0;
    int printed_length = printf("%d/%ld/%.1f/%p\n", 17, 1234567890123L, 4.5, pointer);
    if (printed_length != expected_length + 1 || errno != 0)
        return 5;

    errno = 0;
    long process_id = syscall(SYS_getpid);
    if (process_id <= 0 || errno != 0)
        return 6;

    errno = 0;
    int set_result = prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
    if (set_result != 0 || errno != 0)
        return 7;

    errno = 0;
    int no_new_privs = prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0);
    if (no_new_privs != 1 || errno != 0)
        return 8;

    // Explicit long-sized words remain a valid way to call the raw syscall.
    errno = 0;
    long word_no_new_privs = syscall(SYS_prctl, (long)PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L);
    if (word_no_new_privs != 1 || errno != 0)
        return 9;

    errno = 0;
    long landlock_version = syscall(
        SYS_landlock_create_ruleset,
        NULL,
        0,
        LANDLOCK_CREATE_RULESET_VERSION);
    if (landlock_version == -1) {
        if (errno != ENOSYS)
            return 10;
    } else if (landlock_version < 1 || errno != 0) {
        return 11;
    }

    return 0;
}

static const char *failure_stage(int result)
{
    switch (result) {
    case 1: return "varargs and va_copy";
    case 2: return "pointer formatting";
    case 3: return "expected format construction";
    case 4: return "snprintf formatting";
    case 5: return "printf formatting";
    case 6: return "getpid syscall";
    case 7: return "PR_SET_NO_NEW_PRIVS";
    case 8: return "PR_GET_NO_NEW_PRIVS";
    case 9: return "word-sized prctl syscall arguments";
    case 10: return "Landlock unsupported-version handling";
    case 11: return "Landlock version result";
    default: return "unknown ABI check";
    }
}

int main(void)
{
    const int result = run_abi_checks();
    if (result != 0) {
        const int error = errno;
        printf("::vm-test::fail: linux64-abi: %s check failed (code=%d errno=%d)\n",
               failure_stage(result), result, error);
        fflush(stdout);
#ifdef __wasm__
        for (;;) sched_yield();
#else
        return result;
#endif
    }

    puts("linux64-abi: varargs, formatting, syscall, prctl and Landlock ABI checks pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#endif
    return 0;
}
