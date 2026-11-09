// SPDX-License-Identifier: MIT
extern int lazy_later(int value);

int lazy_ready(void)
{
    return 7;
}

/* Keep this as a direct call so the unresolved symbol is a function import. */
int lazy_use(int value)
{
    return lazy_later(value);
}
