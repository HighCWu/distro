// SPDX-License-Identifier: MIT
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>

extern long api(long);
extern int old_api(int), old_again(int), setting, old_setting, same_unit(void);
extern int (*volatile saved_old)(int);
extern int *saved_setting;
__asm__(".symver old_api, api@VER_1\n"
        ".symver old_again, api@VER_1\n"
        ".symver old_setting, setting@VER_1\n");

static void require(int condition, const char *operation)
{
    if (!condition) {
        fprintf(stderr, "::vm-test::fail: symbol versions: %s\n", operation);
        exit(1);
    }
}

int main(void)
{
    long x = 5;
#if LONG_MAX > 2147483647L
    x += 1L << 40;
#endif
    long (*volatile default_pointer)(long) = api;
    int (*volatile old_pointer)(int) = old_again;
    int (*volatile first_old_pointer)(int) = old_api;
    int *volatile old_address = &old_setting;
    int *volatile default_address = &setting;
    require(api(x) == x + 200 && default_pointer(x) == x + 200 &&
            old_api(7) == 18 && old_pointer(7) == 18 && same_unit() == 76,
            "different signatures, same-unit references and full-width indirect calls");
    puts("symbol versions: old/default calls, long width and same-unit bindings pass");
    require(saved_old == first_old_pointer && first_old_pointer == old_pointer &&
            saved_setting == old_address && default_address != old_address &&
            setting == 23 && old_setting == 17, "function and data relocation identity");
    old_setting = 41;
    require(*saved_setting == 41 && setting == 23 && same_unit() == 124,
            "versioned mutation and default namespace isolation");
    puts("symbol versions: canonical pointers, writable data and namespace isolation pass");
    return 0;
}
