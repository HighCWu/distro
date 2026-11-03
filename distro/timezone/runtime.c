// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "::vm-test::fail: timezone: %s errno=%d\n", what, errno);
        exit(1);
    }
}

static void select_zone(const char *path)
{
    char setting[512];
    int length = snprintf(setting, sizeof setting, ":%s", path);
    require(length > 0 && length < (int)sizeof setting && setenv("TZ", setting, 1) == 0,
            "select standard TZ file");
    tzset();
}

static void check(time_t instant, int hour, int offset, int daylight, const char *abbreviation)
{
    struct tm value;
    require(localtime_r(&instant, &value) && value.tm_hour == hour && value.tm_min == 0 &&
            value.tm_sec == 0 && value.tm_gmtoff == offset && value.tm_isdst == daylight &&
            !strcmp(value.tm_zone, abbreviation), "localtime zone, offset and daylight transition");
    char text[128];
    require(strftime(text, sizeof text, "%Y-%m-%d %H:%M:%S %z %Z", &value) > 0 &&
            strstr(text, abbreviation), "standard strftime timezone output");
    require(mktime(&value) == instant, "localtime/mktime roundtrip");
}

int main(int argc, char **argv)
{
    const char *west = argc == 3 ? argv[1] : "/tz-west";
    const char *east = argc == 3 ? argv[2] : "/tz-east";
    const time_t winter = 2210241600LL, summer = 2225966400LL;
    require(setvbuf(stdout, NULL, _IONBF, 0) == 0, "unbuffered stages");
    struct tm utc;
    require(gmtime_r(&winter, &utc) && utc.tm_year == 140 && utc.tm_hour == 12 && utc.tm_mon == 0 && utc.tm_mday == 15,
            "winter UTC fixture");
    require(gmtime_r(&summer, &utc) && utc.tm_year == 140 && utc.tm_hour == 12 && utc.tm_mon == 6 && utc.tm_mday == 15,
            "summer UTC fixture");
    int baseline = open(west, O_RDONLY | O_CLOEXEC);
    require(baseline >= 0 && close(baseline) == 0, "initial descriptor baseline");
    select_zone(west);
    check(winter, 7, -18000, 0, "EST");
    check(summer, 8, -14400, 1, "EDT");
    select_zone(east);
    check(winter, 21, 32400, 0, "JST");
    check(summer, 21, 32400, 0, "JST");
    puts("timezone: installed TZif, daylight transitions, formatting and time64 roundtrip pass");

    for (int i = 0; i < 64; i++) {
        select_zone(i & 1 ? east : west);
        check(summer, i & 1 ? 21 : 8, i & 1 ? 32400 : -14400, !(i & 1), i & 1 ? "JST" : "EDT");
        int fd = open(west, O_RDONLY | O_CLOEXEC);
        require(fd == baseline && close(fd) == 0, "reload closes file and preserves available descriptors");
    }
    puts("timezone: repeated file reloads, old-map replacement and fd closure pass");
#ifdef __wasm__
    /* A TZ pathname may name a FIFO. Match the nonblocking mmap loader's
     * open behavior rather than hanging under libc's internal timezone lock.
     */
    require(mkfifo("/tz-pipe", 0600) == 0, "create FIFO timezone source");
    select_zone("/tz-pipe");
    check(winter, 12, 0, 0, "UTC");
    select_zone(west);
    check(summer, 8, -14400, 1, "EDT");
    int fd = open(west, O_RDONLY | O_CLOEXEC);
    require(fd == baseline && close(fd) == 0 && unlink("/tz-pipe") == 0,
            "nonregular fallback closes fd and later valid loading recovers");
    puts("timezone: nonblocking FIFO refusal, UTC fallback and later TZif recovery pass");

    /* Linux UAPI classic-BPF layouts, local to this test. Deny read before
     * libc reloads a different TZif: only the standard file-mmap path can
     * populate its contents without issuing a userspace read syscall. */
    struct filter { uint16_t code; uint8_t jt, jf; uint32_t k; };
    const struct filter instructions[] = {
        { 0x20, 0, 0, 0 },
        { 0x15, 0, 1, SYS_read },
        { 0x06, 0, 0, 0x00050000 | EACCES },
        { 0x06, 0, 0, 0x7fff0000 },
    };
    const struct { unsigned short len; const struct filter *filter; } program = {
        sizeof instructions / sizeof instructions[0], instructions,
    };
    require(prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) == 0 &&
            syscall(SYS_seccomp, 1L, 0L, (long)&program, 0L, 0L, 0L) == 0,
            "install standard read-denial filter");
    char byte;
    errno = 0;
    require(read(-1, &byte, 1) == -1 && errno == EACCES, "read actually denied before fd lookup");
    select_zone(east);
    check(summer, 21, 32400, 0, "JST");
    select_zone(west);
    check(summer, 8, -14400, 1, "EDT");
    fd = open(west, O_RDONLY | O_CLOEXEC);
    require(fd == baseline && close(fd) == 0, "mapped reload retains descriptor cleanup");
    puts("timezone: standard private mappings reload TZif while read syscalls are denied pass");
#endif
    puts("::vm-test::pass");
#ifdef __wasm__
    for (;;) pause();
#endif
}
