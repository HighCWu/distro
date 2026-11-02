// SPDX-License-Identifier: MIT
extern int cycle_b_value;
extern int cycle_b_step(int);
int cycle_a_value = 3;
int cycle_a_count;
int cycle_a_observed;
int *cycle_a_saved = &cycle_b_value;
int (*cycle_a_function)(int) = cycle_b_step;
typedef int vector4 __attribute__((vector_size(16)));
extern vector4 cycle_b_vector(vector4);
vector4 cycle_a_vector_base(vector4 n)
{
    return n + (vector4){10, 20, 30, 40};
}
int cycle_vector_check(void)
{
    vector4 result = cycle_b_vector((vector4){1, 2, 3, 4});
    return result[0] + result[1] + result[2] + result[3];
}
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
