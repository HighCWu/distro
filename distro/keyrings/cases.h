// SPDX-License-Identifier: MIT
/* Private workload helpers only; no libc or SDK API. */
#include <linux/keyctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static const unsigned char replacement[] = {0xff, 0, 'u', 'p', 'd', 'a', 't', 'e'};

static long kc(long operation, long a, long b, long c, long d)
{
    return syscall(SYS_keyctl, operation, a, b, c, d, 0L);
}

static long find_key(long ring, const char *description)
{
    return kc(KEYCTL_SEARCH, ring, (long)"user", (long)description, 0);
}

static long read_key(long key, void *buffer, size_t size)
{
    return kc(KEYCTL_READ, key, (long)buffer, (long)size, 0);
}
