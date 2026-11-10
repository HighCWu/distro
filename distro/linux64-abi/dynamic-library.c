// SPDX-License-Identifier: MIT
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

typedef int (*linux64_abi_variadic_callback)(void *context, const char *format, ...);

static const char expected_format[] = "%d/%u/%p/%.1f";
static const int expected_signed = 17;
static const unsigned int expected_unsigned = 4000000001u;
static const double expected_double = 4.5;

int linux64_abi_dso_exchange(
    linux64_abi_variadic_callback callback,
    void *context,
    const char *format,
    ...)
{
    if (callback == NULL || format == NULL || strcmp(format, expected_format) != 0)
        return 1;

    va_list args;
    va_start(args, format);
    int signed_value = va_arg(args, int);
    unsigned int unsigned_value = va_arg(args, unsigned int);
    void *pointer_value = va_arg(args, void *);
    double double_value = va_arg(args, double);
    va_end(args);

    if (signed_value != expected_signed || unsigned_value != expected_unsigned ||
        pointer_value == NULL || double_value != expected_double)
        return 2;

    // These calls cross from this shared object into the main process's libc.
    char pointer_text[64];
    char expected[128];
    char actual[128];
    int pointer_length = snprintf(pointer_text, sizeof(pointer_text), "%p", pointer_value);
    if (pointer_length < 1 || pointer_length >= (int)sizeof(pointer_text))
        return 3;
    int expected_length = snprintf(
        expected, sizeof(expected), "%d/%u/%s/%.1f",
        signed_value, unsigned_value, pointer_text, double_value);
    int actual_length = snprintf(
        actual, sizeof(actual), format,
        signed_value, unsigned_value, pointer_value, double_value);
    if (expected_length < 0 || expected_length >= (int)sizeof(expected) ||
        actual_length != expected_length || strcmp(actual, expected) != 0)
        return 4;

    // The callback type is a real variadic function pointer; no ABI casts are
    // used to reshape the integer, pointer, or floating-point arguments.
    return callback(context, format, signed_value, unsigned_value, pointer_value, double_value);
}
