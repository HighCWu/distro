// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static void fail_errno(const char *operation)
{
    perror(operation);
    exit(EXIT_FAILURE);
}

static void require(int condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "fork memory advice failure: %s\n", message);
        exit(EXIT_FAILURE);
    }
}

static unsigned char *map_anonymous(size_t length)
{
    void *mapping = mmap(NULL, length, PROT_READ | PROT_WRITE,
                         MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (mapping == MAP_FAILED)
        fail_errno("mmap");
    return mapping;
}

static int has_byte_pattern(const unsigned char *memory, size_t length,
                            unsigned char expected)
{
    for (size_t i = 0; i < length; ++i) {
        if (memory[i] != expected)
            return 0;
    }
    return 1;
}

static int wait_for_successful_child(pid_t child)
{
    int status;
    pid_t waited;
    do {
        waited = waitpid(child, &status, 0);
    } while (waited == -1 && errno == EINTR);
    return waited == child && WIFEXITED(status) && WEXITSTATUS(status) == 0;
}

static pid_t fork_or_fail(void)
{
    pid_t child = fork();
    if (child == -1)
        fail_errno("fork");
    return child;
}

static void check_original_patterns(const unsigned char *memory, size_t page_size)
{
    require(has_byte_pattern(memory, page_size, 0x31),
            "parent's first page changed");
    require(has_byte_pattern(memory + page_size, page_size, 0x42),
            "parent's middle page changed");
    require(has_byte_pattern(memory + 2 * page_size, page_size, 0x53),
            "parent's last page changed");
}

int main(void)
{
    long page_size_result = sysconf(_SC_PAGESIZE);
    require(page_size_result > 0, "sysconf did not return a valid page size");
    size_t page_size = (size_t)page_size_result;
    size_t region_size = 3 * page_size;
    unsigned char *region = map_anonymous(region_size);

    memset(region, 0x31, page_size);
    memset(region + page_size, 0x42, page_size);
    memset(region + 2 * page_size, 0x53, page_size);
    if (madvise(region, region_size, MADV_WIPEONFORK) != 0)
        fail_errno("madvise(MADV_WIPEONFORK)");
    if (madvise(region + page_size, page_size, MADV_KEEPONFORK) != 0)
        fail_errno("madvise(MADV_KEEPONFORK)");

    pid_t child = fork_or_fail();
    if (child == 0) {
        if (!has_byte_pattern(region, page_size, 0) ||
            !has_byte_pattern(region + page_size, page_size, 0x42) ||
            !has_byte_pattern(region + 2 * page_size, page_size, 0))
            _exit(11);

        memset(region, 0x6d, page_size);
        pid_t grandchild = fork();
        if (grandchild == -1)
            _exit(12);
        if (grandchild == 0) {
            int wiped_again = has_byte_pattern(region, page_size, 0) &&
                              has_byte_pattern(region + page_size, page_size, 0x42) &&
                              has_byte_pattern(region + 2 * page_size, page_size, 0);
            _exit(wiped_again ? 0 : 13);
        }

        if (!wait_for_successful_child(grandchild))
            _exit(14);
        int child_write_retained =
            has_byte_pattern(region, page_size, 0x6d) &&
            has_byte_pattern(region + page_size, page_size, 0x42) &&
            has_byte_pattern(region + 2 * page_size, page_size, 0);
        _exit(child_write_retained ? 0 : 15);
    }

    require(wait_for_successful_child(child),
            "child/grandchild partial wipe and keep checks failed");
    check_original_patterns(region, page_size);
    puts("fork memory advice: partial wipe and keep ranges pass");
    puts("fork memory advice: inherited wiping across nested fork pass");

    if (madvise(region, region_size, MADV_KEEPONFORK) != 0)
        fail_errno("madvise(MADV_KEEPONFORK) clear");
    child = fork_or_fail();
    if (child == 0) {
        int retained = has_byte_pattern(region, page_size, 0x31) &&
                       has_byte_pattern(region + page_size, page_size, 0x42) &&
                       has_byte_pattern(region + 2 * page_size, page_size, 0x53);
        _exit(retained ? 0 : 21);
    }
    require(wait_for_successful_child(child),
            "KEEPONFORK did not preserve every page in a new child");
    check_original_patterns(region, page_size);

    void *kept_mapping = mremap(region, region_size, 2 * page_size, 0);
    require(kept_mapping == region,
            "KEEPONFORK did not restore a contiguous remappable range");
    region_size = 2 * page_size;

    unsigned char *marked = map_anonymous(page_size);
    memset(marked, 0x64, page_size);
    if (madvise(marked, page_size, MADV_WIPEONFORK) != 0)
        fail_errno("madvise(MADV_WIPEONFORK) before mremap");
    size_t grown_size = 2 * page_size;
    void *grown_mapping = mremap(marked, page_size, grown_size, MREMAP_MAYMOVE);
    if (grown_mapping == MAP_FAILED)
        fail_errno("mremap(MREMAP_MAYMOVE)");
    unsigned char *grown = grown_mapping;
    memset(grown + page_size, 0x75, page_size);

    child = fork_or_fail();
    if (child == 0) {
        int advice_inherited = has_byte_pattern(grown, grown_size, 0);
        _exit(advice_inherited ? 0 : 22);
    }
    require(wait_for_successful_child(child),
            "mremap growth did not preserve WIPEONFORK behavior");
    require(has_byte_pattern(grown, page_size, 0x64),
            "parent's remapped first page changed");
    require(has_byte_pattern(grown + page_size, page_size, 0x75),
            "parent's remapped growth page changed");
    puts("fork memory advice: keep and remap inheritance pass");

    if (munmap(region, region_size) != 0)
        fail_errno("munmap(advised region)");
    if (munmap(grown, grown_size) != 0)
        fail_errno("munmap(remapped region)");

    child = fork_or_fail();
    if (child == 0)
        _exit(0);
    require(wait_for_successful_child(child),
            "ordinary fork did not recover after cleanup");
    return 0;
}
