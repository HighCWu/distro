// SPDX-License-Identifier: MIT
extern int library_value, constructor_count;
extern int library_add(int);
extern int main_add(int);
static int initial;
static int *saved = &library_value;
__attribute__((constructor)) static void initialize(void) { initial = *saved; }
int plugin_initial(void) { return initial; }
int plugin_count(void) { return constructor_count; }
int plugin_run(int value) { return library_add(value) + main_add(value); }
int *plugin_data(void) { return saved; }
int (*plugin_function(void))(int) { return library_add; }
