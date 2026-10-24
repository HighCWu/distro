// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/auxv.h>
#include <unistd.h>

int main(int argc, char **argv)
{
    if (argc != 2) return 81;
    int secure = !strcmp(argv[1], "suid");
    int plain = !strcmp(argv[1], "plain");
    if (!secure && !plain && strcmp(argv[1], "nnp") && strcmp(argv[1], "recovery")) return 82;
    uid_t real = plain ? 0 : 1000, effective = secure ? 0 : real;
    if (getuid() != real || geteuid() != effective) return 83;
    errno = 0;
    if (getauxval(AT_SECURE) != (unsigned long)secure || errno) return 84;
    if (getauxval(AT_UID) != real || getauxval(AT_EUID) != effective) return 85;
    if (getauxval(AT_GID) != (plain ? 0UL : 1000UL) ||
        getauxval(AT_EGID) != (plain ? 0UL : 1000UL)) return 86;
    const char *sentinel = getenv("EXEC_SECURITY_SENTINEL");
    if (!sentinel || strcmp(sentinel, "present")) return 87;
    const char *visible = secure_getenv("EXEC_SECURITY_SENTINEL");
    if (secure ? visible != NULL : !visible || strcmp(visible, "present")) return 88;
    const char *execfn = (const char *)getauxval(AT_EXECFN);
    const char *expected = secure || !strcmp(argv[1], "nnp") ? "/secure-helper" : "/plain-helper";
    if (!execfn || strcmp(execfn, expected)) return 89;
    printf("exec-security-helper: %s committed credentials and auxv pass\n", argv[1]);
    return 37;
}
