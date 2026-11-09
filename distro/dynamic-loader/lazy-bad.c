// SPDX-License-Identifier: MIT
extern int main_lazy_bad_count;

long long lazy_later(long long value)
{
    return value + 9000;
}

__attribute__((constructor)) static void initialize(void)
{
    main_lazy_bad_count++;
}
