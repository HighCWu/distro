/* SPDX-License-Identifier: MIT */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>
#ifdef __wasm__
#include <sched.h>
#endif

int main(void)
{
    unsigned char input[8192], output[sizeof(input)];
    const uLong bound = compressBound(sizeof(input));
    unsigned char *compressed = malloc(bound);
    uLongf compressed_size = bound, output_size = sizeof(output);
    int result = EXIT_FAILURE;

    if (!compressed) {
        puts("::vm-test::fail: zlib allocation");
        return result;
    }
    for (size_t i = 0; i < sizeof(input); ++i)
        input[i] = (unsigned char)(i % 251);
    if (strcmp(zlibVersion(), ZLIB_VERSION) != 0) {
        puts("::vm-test::fail: zlib header/library version mismatch");
        goto done;
    }
    if (compress2(compressed, &compressed_size, input, sizeof(input),
                  Z_BEST_COMPRESSION) != Z_OK || compressed_size >= sizeof(input)) {
        puts("::vm-test::fail: zlib compression");
        goto done;
    }
    if (uncompress(output, &output_size, compressed, compressed_size) != Z_OK ||
        output_size != sizeof(input) || memcmp(input, output, sizeof(input))) {
        puts("::vm-test::fail: zlib roundtrip");
        goto done;
    }
    /* Corrupt the Adler-32 trailer and require a data error. */
    compressed[compressed_size - 1] ^= 1;
    output_size = sizeof(output);
    if (uncompress(output, &output_size, compressed, compressed_size) != Z_DATA_ERROR) {
        puts("::vm-test::fail: zlib corrupted stream accepted");
        goto done;
    }
    printf("SDK zlib %s: roundtrip and corrupted-stream rejection verified\n", zlibVersion());
    puts("::vm-test::pass");
    result = EXIT_SUCCESS;
done:
    free(compressed);
    fflush(stdout);
#ifdef __wasm__
    if (result == EXIT_SUCCESS)
        for (;;) sched_yield();
#endif
    return result;
}
