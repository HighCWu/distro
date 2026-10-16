/* SPDX-License-Identifier: MIT */
#include <stdio.h>
#ifdef __wasm__
#error the generator must be compiled for the build machine
#endif

int main(int argc, char **argv)
{
    if (argc != 2) return 1;
    FILE *file = fopen(argv[1], "w");
    if (!file) return 1;
    int failed = fputs("#define SDK_GENERATED_ANSWER 42\n", file) == EOF;
    if (fclose(file)) failed = 1;
    return failed;
}
