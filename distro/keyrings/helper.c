// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "cases.h"

int main(int argc, char **argv)
{
    if (argc != 3) return 81;
    char *end;
    errno = 0;
    long key = strtol(argv[1], &end, 10);
    if (errno || *end || key <= 0) return 82;
    long session = strtol(argv[2], &end, 10);
    if (errno || *end || session <= 0) return 83;
    if (kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING, 0, 0, 0) != session ||
        find_key(session, "wasm-binary") != key) return 84;
    unsigned char bytes[sizeof replacement];
    if (read_key(key, bytes, sizeof bytes) != sizeof bytes || memcmp(bytes, replacement, sizeof bytes)) return 85;
    errno = 0;
    if (kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_THREAD_KEYRING, 0, 0, 0) != -1 || errno != ENOKEY) return 86;
    errno = 0;
    if (kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_PROCESS_KEYRING, 0, 0, 0) != -1 || errno != ENOKEY) return 87;
    puts("keyring-helper: retained session, binary payload and discarded local rings pass");
    return 37;
}
