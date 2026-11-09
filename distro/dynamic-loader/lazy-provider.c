// SPDX-License-Identifier: MIT
extern int main_lazy_call(int value);

int lazy_provider_count;
int lazy_provider_observed;

int lazy_later(int value)
{
    return value + 41;
}

__attribute__((constructor)) static void initialize(void)
{
    lazy_provider_count++;
    lazy_provider_observed = main_lazy_call(1);
}
