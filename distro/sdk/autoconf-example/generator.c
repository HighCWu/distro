/* SPDX-License-Identifier: MIT */
#include <stdio.h>
#ifdef __wasm__
#error the build-time generator must use the build-machine compiler
#endif
int main(void)
{
    return puts("#define SDK_GENERATED_SIZE 64") < 0 || fflush(stdout) != 0;
}
