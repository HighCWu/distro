/* SPDX-License-Identifier: MIT */
#ifdef __wasm__
#error the generator library must be compiled for the build machine
#endif

int sdk_generator_answer(void)
{
    return 42;
}
