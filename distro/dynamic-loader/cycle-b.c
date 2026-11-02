// SPDX-License-Identifier: MIT
extern int cycle_a_value;
extern int cycle_a_step(int);
int cycle_b_value = 5;
int cycle_b_count;
int cycle_b_observed;
int *cycle_b_saved = &cycle_a_value;
int (*cycle_b_function)(int) = cycle_a_step;
int cycle_b_step(int n)
{
    return n ? cycle_a_step(n - 1) + 1 : cycle_b_value;
}
__attribute__((constructor)) static void initialize(void)
{
    cycle_b_count++;
    cycle_b_observed = cycle_a_step(0);
    cycle_b_value += *cycle_b_saved;
}
