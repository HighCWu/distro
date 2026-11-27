// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(void)
{
    FILE *fp = fopen("/proc/kallsyms", "r");
    if (!fp) {
        perror("fopen(/proc/kallsyms)");
        return 1;
    }

    char line[1024];
    unsigned long count = 0;
    unsigned long nonzero = 0;
    int saw_schedule = 0;
    int saw_printk = 0;

    while (fgets(line, sizeof(line), fp) != NULL) {
        unsigned long long addr = 0;
        char type = 0;
        char name[512];
        if (sscanf(line, "%llx %c %511s", &addr, &type, name) != 3) {
            continue;
        }
        count++;
        if (addr != 0) nonzero++;
        if (strcmp(name, "schedule") == 0) saw_schedule = 1;
        if (strcmp(name, "_printk") == 0 || strcmp(name, "printk") == 0) saw_printk = 1;
    }

    if (fclose(fp) != 0) {
        perror("fclose(/proc/kallsyms)");
        return 1;
    }

    if (count == 0 || nonzero == 0 || !saw_schedule || !saw_printk) {
        fprintf(stderr, "kallsyms check failed count=%lu nonzero=%lu schedule=%d printk=%d\n",
                count, nonzero, saw_schedule, saw_printk);
        return 1;
    }

    printf("KALLSYMS_OK count=%lu nonzero=%lu\n", count, nonzero);
    return 0;
}
