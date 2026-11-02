// SPDX-License-Identifier: MIT
__asm__(".symver impl_old, api@VER_1\n"
        ".symver impl_new, api@@VER_2\n"
        ".symver data_old, setting@VER_1\n"
        ".symver data_new, setting@@VER_2\n");
int impl_old(int x) { return x + 11; }
long impl_new(long x) { return x + 200; }
int data_old = 17;
int data_new = 23;

/* These references and the default definition coexist in one C unit. */
extern int api(int), same_old(int), setting, same_setting;
__asm__(".symver api, api@VER_1\n"
        ".symver same_old, api@VER_1\n"
        ".symver setting, setting@VER_1\n"
        ".symver same_setting, setting@VER_1\n");
int (*volatile saved_old)(int) = api;
int *saved_setting = &setting;
int same_unit(void)
{
    return api(2) + same_old(3) + saved_old(4) + setting + same_setting;
}
