// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <inttypes.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc != 2 && !(argc == 3 && !strcmp(argv[1], "output"))) return 2;
    if (!strcmp(argv[1], "output")) {
        FILE *output = fopen(argc == 3 ? argv[2] : "/root/result.bin", "wb");
        if (!output) return 8;
        int failed = 0;
        for (size_t i = 0; i < 65536 + 17; i++) {
            if (fputc((unsigned char)(i * 37 + 11), output) == EOF) { failed = 1; break; }
        }
        if (fclose(output)) failed = 1;
        if (failed) return 9;
        puts("created /root/result.bin");
        return 0;
    }
    if (!strcmp(argv[1], "wait")) {
        puts("uploaded application waiting");
        fflush(stdout);
        for (;;) pause();
    }
    if (!strcmp(argv[1], "fail")) {
        fputs("uploaded application expected failure\n", stderr);
        return 37;
    }
    if (!strcmp(argv[1], "stdin")) {
        unsigned char buffer[4096];
        size_t size;
        while ((size = fread(buffer, 1, sizeof(buffer), stdin))) {
            if (fwrite(buffer, 1, size, stdout) != size) return 4;
        }
        return ferror(stdin) ? 5 : 0;
    }
    if (!strcmp(argv[1], "prefix")) {
        int byte = getchar();
        if (byte == EOF) return 6;
        printf("prefix byte: %u\n", (unsigned int)(unsigned char)byte);
        return 0;
    }
    if (!strcmp(argv[1], "checksum") || !strcmp(argv[1], "pattern")) {
        int pattern = !strcmp(argv[1], "pattern");
        unsigned char buffer[4096];
        uint64_t count = 0, sum = 0;
        size_t size;
        while ((size = fread(buffer, 1, sizeof(buffer), stdin))) {
            for (size_t i = 0; i < size; i++) {
                if (pattern && buffer[i] != (unsigned char)((count + i) * 37 + 11)) return 7;
                sum += buffer[i];
            }
            count += size;
        }
        if (ferror(stdin)) return 5;
        printf("input bytes: %" PRIu64 ", sum: %" PRIu64 "\n", count, sum);
        return 0;
    }
    if (getchar() != EOF) return 3;
    printf("uploaded application: %s\n", argv[1]);
    fputs("uploaded application stderr\n", stderr);
    return 0;
}
