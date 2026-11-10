// SPDX-License-Identifier: MIT
#include <dlfcn.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

typedef int (*linux64_abi_variadic_callback)(void *context, const char *format, ...);
typedef int (*linux64_abi_dso_function)(
    linux64_abi_variadic_callback callback,
    void *context,
    const char *format,
    ...);

struct callback_state {
    void *expected_pointer;
    int calls;
};

static const char expected_format[] = "%d/%u/%p/%.1f";
static const int expected_signed = 17;
static const unsigned int expected_unsigned = 4000000001u;
static const double expected_double = 4.5;

static int fail(const char *message)
{
    fprintf(stderr, "linux64-abi dynamic runtime: %s\n", message);
    return 1;
}

int linux64_abi_main_callback(void *context, const char *format, ...)
{
    struct callback_state *state = context;
    if (state == NULL || format == NULL || strcmp(format, expected_format) != 0)
        return 1;

    va_list args;
    va_list copied;
    va_start(args, format);
    va_copy(copied, args);

    int signed_value = va_arg(args, int);
    unsigned int unsigned_value = va_arg(args, unsigned int);
    void *pointer_value = va_arg(args, void *);
    double double_value = va_arg(args, double);
    int copied_signed = va_arg(copied, int);
    unsigned int copied_unsigned = va_arg(copied, unsigned int);
    void *copied_pointer = va_arg(copied, void *);
    double copied_double = va_arg(copied, double);

    va_end(copied);
    va_end(args);

    if (signed_value != expected_signed || unsigned_value != expected_unsigned ||
        pointer_value != state->expected_pointer || double_value != expected_double ||
        copied_signed != expected_signed || copied_unsigned != expected_unsigned ||
        copied_pointer != state->expected_pointer || copied_double != expected_double)
        return 2;

    ++state->calls;
    return 0;
}

int main(int argc, char **argv)
{
    const char *plugin_path = argc == 2 ? argv[1] : "/plugins/liblinux64-abi-variadic.so";
    if (argc > 2)
        return fail("expected at most one shared-library path");

    void *handle = dlopen(plugin_path, RTLD_NOW | RTLD_LOCAL);
    if (handle == NULL) {
        const char *error = dlerror();
        fprintf(stderr, "linux64-abi dynamic runtime: dlopen(%s): %s\n",
                plugin_path, error == NULL ? "unknown error" : error);
        return 1;
    }

    (void)dlerror();
    void *address = dlsym(handle, "linux64_abi_dso_exchange");
    const char *lookup_error = dlerror();
    if (address == NULL || lookup_error != NULL) {
        fprintf(stderr, "linux64-abi dynamic runtime: dlsym: %s\n",
                lookup_error == NULL ? "null symbol address" : lookup_error);
        (void)dlclose(handle);
        return 1;
    }
    linux64_abi_dso_function dso_exchange = (linux64_abi_dso_function)address;

    int marker = 0;
    struct callback_state callback = {
        .expected_pointer = &marker,
        .calls = 0,
    };
    int result = dso_exchange(
        linux64_abi_main_callback,
        &callback,
        expected_format,
        expected_signed,
        expected_unsigned,
        callback.expected_pointer,
        expected_double);
    if (result != 0 || callback.calls != 1) {
        (void)dlclose(handle);
        return fail("main-to-DSO varargs or DSO-to-main variadic callback failed");
    }

    char pointer_text[64];
    char output[128];
    int pointer_length = snprintf(pointer_text, sizeof(pointer_text), "%p", callback.expected_pointer);
    if (pointer_length < 1 || pointer_length >= (int)sizeof(pointer_text)) {
        (void)dlclose(handle);
        return fail("main libc pointer formatting failed");
    }
    int expected_length = snprintf(
        output, sizeof(output), "%d/%u/%s/%.1f",
        expected_signed, expected_unsigned, pointer_text, expected_double);
    int formatted_length = snprintf(
        output, sizeof(output), expected_format,
        expected_signed, expected_unsigned, callback.expected_pointer, expected_double);
    if (formatted_length != expected_length || formatted_length < 0 ||
        formatted_length >= (int)sizeof(output)) {
        (void)dlclose(handle);
        return fail("main-to-libc variadic formatting failed");
    }

    printf("linux64-abi dynamic varargs: %s\n", output);
    if (dlclose(handle) != 0)
        return fail("dlclose failed");
    return 0;
}
