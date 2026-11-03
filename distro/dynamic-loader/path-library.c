// SPDX-License-Identifier: MIT
// No interposable mutable state: each distinct inode owns its constructor data.
static int value = 41;
static int initialized;
__attribute__((constructor)) static void initialize(void)
{
    value++;
    initialized++;
}
int path_library_value(void) { return value; }
int path_library_count(void) { return initialized; }
