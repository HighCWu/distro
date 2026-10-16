// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
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
    if (getchar() != EOF) return 3;
    printf("uploaded application: %s\n", argv[1]);
    fputs("uploaded application stderr\n", stderr);
    return 0;
}
