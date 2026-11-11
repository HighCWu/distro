// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <unistd.h>

static int fail(const char *what)
{
    fprintf(stderr, "prctl-mm-map: %s (errno=%d: %s)\n", what, errno, strerror(errno));
    return 1;
}

static int read_file(const char *path, char *buffer, size_t capacity, size_t *length)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0)
        return -1;

    size_t used = 0;
    for (;;) {
        if (used == capacity) {
            errno = EOVERFLOW;
            close(fd);
            return -1;
        }
        ssize_t count = read(fd, buffer + used, capacity - used);
        if (count < 0 && errno == EINTR)
            continue;
        if (count < 0) {
            int saved_errno = errno;
            close(fd);
            errno = saved_errno;
            return -1;
        }
        if (count == 0)
            break;
        used += (size_t)count;
    }

    if (close(fd) < 0)
        return -1;
    *length = used;
    return 0;
}

static int parse_address(const char *token, uint64_t *value)
{
    char *end;
    errno = 0;
    unsigned long long parsed = strtoull(token, &end, 10);
    if (errno || end == token || *end != '\0')
        return -1;
    *value = (uint64_t)parsed;
    return 0;
}

static int read_stat_map(struct prctl_mm_map *map)
{
    char buffer[8192];
    size_t length;
    if (read_file("/proc/self/stat", buffer, sizeof(buffer) - 1, &length) < 0)
        return -1;
    buffer[length] = '\0';

    // The comm field is parenthesized and may contain spaces or ')'. Its final
    // closing parenthesis is followed by the state field and numeric fields.
    char *comm_end = strrchr(buffer, ')');
    if (comm_end == NULL || comm_end[1] != ' ') {
        errno = EPROTO;
        return -1;
    }

    char *cursor = comm_end + 1;
    uint64_t values[52] = {0};
    bool read_field[52] = {0};
    read_field[26] = true;
    read_field[27] = true;
    read_field[28] = true;
    read_field[45] = true;
    read_field[46] = true;
    read_field[47] = true;
    read_field[48] = true;
    read_field[49] = true;
    read_field[50] = true;
    read_field[51] = true;

    for (unsigned int field = 3; field <= 51; ++field) {
        while (*cursor == ' ' || *cursor == '\t')
            ++cursor;
        if (*cursor == '\0') {
            errno = EPROTO;
            return -1;
        }

        char *token = cursor;
        while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t' && *cursor != '\n')
            ++cursor;
        const char terminator = *cursor;
        *cursor = '\0';

        if (read_field[field] && parse_address(token, &values[field]) < 0) {
            errno = EPROTO;
            return -1;
        }

        if (terminator == '\0') {
            if (field != 51) {
                errno = EPROTO;
                return -1;
            }
            break;
        }
        ++cursor;
    }

    map->start_code = values[26];
    map->end_code = values[27];
    map->start_stack = values[28];
    map->start_data = values[45];
    map->end_data = values[46];
    map->start_brk = values[47];
    map->arg_start = values[48];
    map->arg_end = values[49];
    map->env_start = values[50];
    map->env_end = values[51];

    void *program_break = sbrk(0);
    if (program_break == (void *)-1)
        return -1;

    map->brk = (uint64_t)(uintptr_t)program_break;
    map->auxv = NULL;
    map->auxv_size = 0;
    map->exe_fd = UINT32_MAX;
    return 0;
}

static int set_map(const struct prctl_mm_map *map, unsigned long size)
{
    return prctl(PR_SET_MM, (unsigned long)PR_SET_MM_MAP, (unsigned long)(uintptr_t)map, size, 0UL);
}

static int read_cmdline(unsigned char *buffer, size_t capacity, size_t *length)
{
    return read_file("/proc/self/cmdline", (char *)buffer, capacity, length);
}

static int expect_cmdline(const unsigned char *expected, size_t expected_length, const char *stage)
{
    unsigned char actual[8192];
    size_t actual_length;
    if (read_cmdline(actual, sizeof(actual), &actual_length) < 0)
        return fail("read /proc/self/cmdline");
    if (actual_length != expected_length || memcmp(actual, expected, expected_length) != 0) {
        errno = EIO;
        fprintf(stderr, "prctl-mm-map: command line mismatch after %s\n", stage);
        return 1;
    }
    return 0;
}

static void print_boundaries(const struct prctl_mm_map *map)
{
    fprintf(stderr,
            "prctl-mm-map: proc stat bounds code=%" PRIx64 "..%" PRIx64 " data=%" PRIx64 "..%" PRIx64
            " brk=%" PRIx64 "..%" PRIx64 " stack=%" PRIx64 " args=%" PRIx64 "..%" PRIx64
            " env=%" PRIx64 "..%" PRIx64 "\n",
            (uint64_t)map->start_code, (uint64_t)map->end_code, (uint64_t)map->start_data, (uint64_t)map->end_data,
            (uint64_t)map->start_brk, (uint64_t)map->brk, (uint64_t)map->start_stack, (uint64_t)map->arg_start,
            (uint64_t)map->arg_end, (uint64_t)map->env_start, (uint64_t)map->env_end);
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);

    unsigned int reported_size = 0;
    if (prctl(PR_SET_MM, (unsigned long)PR_SET_MM_MAP_SIZE, (unsigned long)(uintptr_t)&reported_size, 0UL,
              0UL) < 0)
        return fail("PR_SET_MM_MAP_SIZE");
    if (reported_size != sizeof(struct prctl_mm_map)) {
        fprintf(stderr, "prctl-mm-map: kernel size %u differs from userspace size %zu\n",
                reported_size, sizeof(struct prctl_mm_map));
        return 1;
    }
    printf("PR_SET_MM_MAP_SIZE reports %u bytes\n", reported_size);

    char process_name[] = "mm map ) probe";
    if (prctl(PR_SET_NAME, (unsigned long)(uintptr_t)process_name, 0UL, 0UL, 0UL) < 0)
        return fail("set a comm field containing spaces and a closing parenthesis");

    struct prctl_mm_map original = {0};
    if (read_stat_map(&original) < 0)
        return fail("parse /proc/self/stat bounds or query current break");

    unsigned char original_cmdline[8192];
    size_t original_cmdline_length;
    if (read_cmdline(original_cmdline, sizeof(original_cmdline), &original_cmdline_length) < 0)
        return fail("read original /proc/self/cmdline");

    char replacement[] = "prctl-mm-map\0replacement";
    struct prctl_mm_map replacement_map = original;
    replacement_map.arg_start = (uint64_t)(uintptr_t)replacement;
    replacement_map.arg_end = replacement_map.arg_start + sizeof(replacement);
    if (set_map(&replacement_map, sizeof(replacement_map)) < 0) {
        int saved_errno = errno;
        print_boundaries(&replacement_map);
        if (saved_errno == EINVAL && (replacement_map.start_code == 0 || replacement_map.end_code == 0))
            fprintf(stderr, "prctl-mm-map: zero code bounds from /proc/self/stat are rejected by the current map validator\n");
        errno = saved_errno;
        return fail("PR_SET_MM_MAP with current process bounds");
    }
    if (expect_cmdline((const unsigned char *)replacement, sizeof(replacement), "argument range update"))
        return 1;
    puts("PR_SET_MM_MAP updates /proc/self/cmdline from a current stack buffer");

    errno = 0;
    if (set_map(&replacement_map, sizeof(replacement_map) - 1) != -1 || errno != EINVAL)
        return fail("invalid PR_SET_MM_MAP size must return EINVAL");
    if (expect_cmdline((const unsigned char *)replacement, sizeof(replacement), "invalid size rejection"))
        return 1;

    struct prctl_mm_map invalid_map = replacement_map;
    invalid_map.arg_start = UINT64_MAX;
    invalid_map.arg_end = UINT64_MAX;
    errno = 0;
    if (set_map(&invalid_map, sizeof(invalid_map)) != -1 || errno != EINVAL)
        return fail("out-of-range PR_SET_MM_MAP addresses must return EINVAL");
    if (expect_cmdline((const unsigned char *)replacement, sizeof(replacement), "invalid address rejection"))
        return 1;
    puts("PR_SET_MM_MAP rejects bad size and address without changing current state");

    if (set_map(&original, sizeof(original)) < 0)
        return fail("restore original PR_SET_MM_MAP");
    if (expect_cmdline(original_cmdline, original_cmdline_length, "restoring original arguments"))
        return 1;
    puts("PR_SET_MM_MAP restores original /proc/self/cmdline bounds");
    return 0;
}
