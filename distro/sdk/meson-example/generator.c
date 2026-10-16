/* SPDX-License-Identifier: MIT */
#include <stdio.h>
#ifdef __wasm__
#error the generator must be compiled for the build machine
#endif

int sdk_generator_answer(void);

int main(int argc, char **argv)
{
    if (argc != 2) return 1;
    FILE *file = fopen(argv[1], "w");
    if (!file) return 1;
    int failed = fprintf(file, "#define SDK_GENERATED_ANSWER %d\n",
                         sdk_generator_answer()) < 0;
    if (fclose(file)) failed = 1;
    return failed;
}
