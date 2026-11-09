// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dlfcn.h>

extern int next_leaf_anchor;
int *volatile next_middle_dependency = &next_leaf_anchor;
int next_middle_anchor = 11;

/* The relocation retains dlsym's canonical function pointer. Calls through
 * this pointer must still resolve RTLD_NEXT relative to this module. */
static void *(*volatile lookup)(void *, const char *) = dlsym;

int next_chain(int value)
{
    (void)dlerror();
    int (*next)(int) = lookup(RTLD_NEXT, "next_chain");
    if (!next || dlerror() || *next_middle_dependency != 7) return -1000;
    return next(value) + 10;
}
