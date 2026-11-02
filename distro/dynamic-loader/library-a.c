// SPDX-License-Identifier: MIT
extern int main_value;
int library_value = 7;
int constructor_count;
__attribute__((constructor)) static void initialize(void)
{
    constructor_count++;
    library_value += main_value;
}
int library_add(int value) { return library_value += value; }
int *library_data(void) { return &library_value; }
