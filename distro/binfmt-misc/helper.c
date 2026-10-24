// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    const char *mode = getenv("BINFMT_CASE");
    if (!mode) return 81;
    int preserve = !strcmp(mode, "preserve"), creds = !strcmp(mode, "creds");
    int opened = creds || !strcmp(mode, "open");
    if (!preserve && !opened && strcmp(mode, "plain") && strcmp(mode, "fixed")) return 82;
    if (argc != (preserve ? 4 : 3) || strcmp(argv[0], "/misc-helper") ||
        strcmp(argv[1], "/misc-payload") || strcmp(argv[argc-1], "tail-token")) return 83;
    if (preserve && strcmp(argv[2], "original-zero")) return 84;
    unsigned long flags = getauxval(AT_FLAGS);
    /* Linux UAPI AT_FLAGS_PRESERVE_ARGV0 is bit zero. */
    if (!!(flags & 1UL) != preserve) return 85;
    const char *execfn = (const char *)getauxval(AT_EXECFN);
    if (!execfn || strcmp(execfn, "/misc-payload")) return 86;
    uid_t real = opened ? 1000 : 0, effective = creds ? 0 : real;
    if (getuid() != real || geteuid() != effective || getauxval(AT_UID) != real ||
        getauxval(AT_EUID) != effective || getauxval(AT_SECURE) != (unsigned long)creds) return 87;
    const char *sentinel = secure_getenv("BINFMT_SENTINEL");
    if (creds ? sentinel != NULL : !sentinel || strcmp(sentinel, "present")) return 88;
    errno = 0;
    unsigned long execfd = getauxval(AT_EXECFD);
    if (opened) {
        if (errno || !execfd || execfd > 0x7fffffffUL) return 89;
        int fd = (int)execfd;
        struct stat actual, expected;
        unsigned char bytes[8], wanted[] = {'W','B','I','N',0,0xff,0x7f,42};
        if (fstat(fd, &actual) || stat("/misc-payload", &expected) ||
            actual.st_dev != expected.st_dev || actual.st_ino != expected.st_ino ||
            actual.st_size != sizeof bytes || fcntl(fd, F_GETFD) != 0 ||
            read(fd, bytes, sizeof bytes) != sizeof bytes || memcmp(bytes, wanted, sizeof bytes) ||
            close(fd)) return 90;
    } else if (execfd || errno != ENOENT) return 91;
    printf("binfmt-misc-helper: %s argv, auxiliary vector and credentials pass\n", mode);
    return 37;
}
