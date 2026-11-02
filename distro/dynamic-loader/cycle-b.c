// SPDX-License-Identifier: MIT
extern int cycle_a_value;
extern int cycle_a_step(int);
int cycle_b_value = 5;
int cycle_b_count;
int cycle_b_observed;
_Thread_local int cycle_b_tls = 40;
_Thread_local int *volatile cycle_b_tls_saved = &cycle_a_value;
int cycle_b_tls_reference_observed;
static _Thread_local int cycle_b_tls_zero;
int cycle_b_tls_observed;
extern int cycle_a_tls_step(int);
int cycle_b_tls_step(int n) { cycle_b_tls += n; return cycle_b_tls + cycle_b_tls_zero++; }
int *cycle_b_tls_data(void) { return &cycle_b_tls; }
int *cycle_b_tls_relocated(void) { return cycle_b_tls_saved; }
int *cycle_b_saved = &cycle_a_value;
int (*cycle_b_function)(int) = cycle_a_step;
typedef int vector4 __attribute__((vector_size(16)));
extern vector4 cycle_a_vector_base(vector4);
int cycle_b_vector_observed;
vector4 cycle_b_vector(vector4 n)
{
    return cycle_a_vector_base(n) * (vector4){2, 2, 2, 2};
}
int cycle_b_step(int n)
{
    return n ? cycle_a_step(n - 1) + 1 : cycle_b_value;
}
__attribute__((constructor)) static void initialize(void)
{
    cycle_b_count++;
    cycle_b_observed = cycle_a_step(0);
    cycle_b_value += *cycle_b_saved;
    vector4 result = cycle_b_vector((vector4){1, 2, 3, 4});
    cycle_b_vector_observed = result[0] + result[1] + result[2] + result[3];
    cycle_b_tls_observed = cycle_a_tls_step(1);
    cycle_b_tls_reference_observed = cycle_b_tls_saved == &cycle_a_value;
}
