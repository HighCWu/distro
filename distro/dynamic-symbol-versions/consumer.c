// SPDX-License-Identifier: MIT
#include <stddef.h>

extern long api(long);
extern int old_api(int), old_again(int), setting, old_setting, same_unit(void);
extern int (*volatile saved_old)(int);
extern int *saved_setting;
__asm__(".symver old_api, api@VER_1\n"
        ".symver old_again, api@VER_1\n"
        ".symver old_setting, setting@VER_1\n");

int version_checks(long input)
{
    long (*volatile current)(long) = api;
    int (*volatile previous)(int) = old_api;
    int (*volatile repeated)(int) = old_again;
    if (api(input) != input + 200 || current(input) != input + 200 ||
        old_api(7) != 18 || repeated(7) != 18 || same_unit() != 76) return 1;
    if (previous != repeated || saved_old != previous) return 2;
    if (saved_setting != &old_setting || &setting == &old_setting ||
        setting != 23 || old_setting != 17) return 3;
    old_setting = 41;
    if (*saved_setting != 41 || setting != 23 || same_unit() != 124) return 4;
    return 0;
}

int (*version_old_pointer(void))(int) { return old_api; }
long (*version_default_pointer(void))(long) { return api; }
int *version_old_data(void) { return &old_setting; }
int *version_default_data(void) { return &setting; }
