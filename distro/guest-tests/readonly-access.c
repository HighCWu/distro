// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only with the isolated read-only Linux/Wasm shared-directory backend"
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    fprintf(stderr, "readonly access: %s errno=%d\n", what, errno);
    exit(1);
}
int main(int argc, char **argv)
{
    require(argc == 3, "expected existing file and shared-directory paths");
    require(access(argv[1], F_OK) == 0 && access(argv[1], R_OK) == 0 &&
            faccessat(AT_FDCWD, argv[1], R_OK, AT_EACCESS) == 0,
            "existence and read probes remain available");
    puts("readonly access: existence and read probes succeed on the read-only backend pass");
    errno = 0;
    require(access(argv[1], W_OK) == -1 && errno == EROFS, "file write probe follows backend policy");
    errno = 0;
    require(access(argv[1], R_OK | W_OK) == -1 && errno == EROFS, "mixed write probe follows backend policy");
    errno = 0;
    require(access(argv[2], W_OK) == -1 && errno == EROFS, "directory write probe follows backend policy");
    errno = 0;
    require(faccessat(AT_FDCWD, argv[1], W_OK, AT_EACCESS) == -1 && errno == EROFS,
            "effective-ID write probe follows backend policy");
    puts("readonly access: file, directory, mixed and effective-ID write probes return EROFS pass");
    errno = 0;
    require(open(argv[1], O_WRONLY | O_CLOEXEC) == -1 && errno == EROFS, "actual writable open is denied");
    int fd = open(argv[1], O_RDONLY | O_CLOEXEC);
    char byte;
    require(fd >= 0 && read(fd, &byte, 1) == 1 && close(fd) == 0, "read after denied probes");
    char missing[PATH_MAX];
    require(snprintf(missing, sizeof missing, "%s/no-such-access-file", argv[2]) < (int)sizeof missing,
            "bounded missing-file path");
    errno = 0;
    require(access(missing, W_OK) == -1 && errno == ENOENT, "missing path is still ENOENT");
    puts("readonly access: actual open policy, read recovery and missing-path errors remain correct pass");
    return 0;
}
