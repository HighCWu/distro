// SPDX-License-Identifier: MIT
extern int cycle_b_value;
extern int cycle_b_step(int);
int cycle_a_value = 3;
int cycle_a_count;
int cycle_a_observed;
int *cycle_a_saved = &cycle_b_value;
int (*cycle_a_function)(int) = cycle_b_step;
int cycle_a_step(int n)
{
    return n ? cycle_b_step(n - 1) + 1 : cycle_a_value;
}
__attribute__((constructor)) static void initialize(void)
{
    cycle_a_count++;
    cycle_a_observed = cycle_b_step(0);
    cycle_a_value += *cycle_a_saved;
}
