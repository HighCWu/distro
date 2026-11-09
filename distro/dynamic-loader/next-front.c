// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dlfcn.h>

extern int next_middle_anchor;
extern int main_next_lookup(int);
int *volatile next_front_dependency = &next_middle_anchor;
int next_front_constructor_count;
int next_front_constructor_value;

static int next_result(int value, int extra)
{
    (void)dlerror();
    int (*next)(int) = dlsym(RTLD_NEXT, "next_chain");
    if (!next || dlerror() || *next_front_dependency != 11) return -1001;
    return next(value) + extra;
}

int next_chain(int value)
{
    return next_result(value, 1);
}

__attribute__((noinline)) static int private_next(int value)
{
    (void)dlerror();
    int (*next)(int) = dlsym(RTLD_NEXT, "next_chain");
    if (!next || dlerror()) return -1003;
    return next(value) + 3;
}

int (*next_private_function(void))(int)
{
    return private_next;
}

int next_call_main(int value)
{
    return main_next_lookup(value);
}

int next_call_callback(int value, int (*callback)(int))
{
    return callback(value);
}

int next_missing_recovers(int value)
{
    (void)dlerror();
    if (dlsym(RTLD_NEXT, "next_deliberately_missing") || !dlerror() || dlerror())
        return -1002;
    return next_result(value, 1);
}

__attribute__((constructor)) static void initialize(void)
{
    next_front_constructor_count++;
    next_front_constructor_value = next_result(0, 0);
}
