// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <grp.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include "cases.h"

static void require(int ok, const char *what)
{
    if (ok) return;
    printf("::vm-test::fail: keyrings: %s errno=%d\n", what, errno);
    fflush(stdout);
    _Exit(1);
}

static long add(const char *type, const char *name, const void *bytes, size_t size)
{
    return syscall(SYS_add_key, (long)type, (long)name, (long)bytes,
                   (long)size, (long)KEY_SPEC_SESSION_KEYRING, 0L);
}

static void wait_child(pid_t child)
{
    require(child > 0, "fork returns child");
    int status = 0;
    pid_t waited;
    do waited = waitpid(child, &status, 0); while (waited < 0 && errno == EINTR);
    if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 37) {
        printf("keyrings: waited=%ld status=%#x\n", (long)waited, status);
        require(0, "child keyring semantics");
    }
}

int main(void)
{
    long session = kc(KEYCTL_JOIN_SESSION_KEYRING, 0, 0, 0, 0);
    require(session > 0 && kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING, 0, 0, 0) == session,
            "anonymous session keyring");
    const unsigned char original[] = {0, 0xff, 'k', 'e', 'y', 0, 0x7f};
    long key = add("user", "wasm-binary", original, sizeof original);
    require(key > 0 && find_key(session, "wasm-binary") == key &&
            syscall(SYS_request_key, (long)"user", (long)"wasm-binary", 0L, 0L, 0L, 0L) == key,
            "add, search and request existing user key");
    unsigned char bytes[32];
    memset(bytes, 0x5a, sizeof bytes);
    /* An undersized read reports the required length; the contents inside
     * that short buffer are not specified by the kernel key service contract. */
    require(read_key(key, NULL, 0) == sizeof original && read_key(key, bytes, 2) == sizeof original,
            "sizing and short-read required length");
    for (size_t i = 2; i < sizeof bytes; ++i)
        require(bytes[i] == 0x5a, "short read never writes beyond supplied capacity");
    require(read_key(key, bytes, sizeof bytes) == sizeof original &&
            !memcmp(bytes, original, sizeof original), "full binary payload");
    puts("keyrings: session creation, add/request/search and bounded binary reads pass");
    fflush(stdout);

    require(kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_THREAD_KEYRING, 1, 0, 0) > 0 &&
            kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_PROCESS_KEYRING, 1, 0, 0) > 0, "local keyring setup");
    pid_t child = fork();
    require(child >= 0, "fork shared session");
    if (!child) {
        if (kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_SESSION_KEYRING, 0, 0, 0) != session ||
            find_key(session, "wasm-binary") != key) _exit(81);
        errno = 0;
        if (kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_THREAD_KEYRING, 0, 0, 0) != -1 || errno != ENOKEY) _exit(82);
        errno = 0;
        if (kc(KEYCTL_GET_KEYRING_ID, KEY_SPEC_PROCESS_KEYRING, 0, 0, 0) != -1 || errno != ENOKEY) _exit(83);
        if (kc(KEYCTL_UPDATE, key, (long)replacement, sizeof replacement, 0)) _exit(84);
        _exit(37);
    }
    wait_child(child);
    require(read_key(key, bytes, sizeof bytes) == sizeof replacement &&
            !memcmp(bytes, replacement, sizeof replacement), "child update visible in parent");
    child = fork();
    require(child >= 0, "fork isolated session");
    if (!child) {
        long isolated = kc(KEYCTL_JOIN_SESSION_KEYRING, 0, 0, 0, 0);
        if (isolated <= 0 || isolated == session) _exit(85);
        errno = 0;
        if (find_key(isolated, "wasm-binary") != -1 || errno != ENOKEY) _exit(86);
        _exit(37);
    }
    wait_child(child);
    require(find_key(session, "wasm-binary") == key, "parent session remains subscribed");
    puts("keyrings: shared fork updates, fresh local rings and isolated session replacement pass");
    fflush(stdout);

    /* KEY_USR_ALL, with no possessor/group/other permissions. */
    require(kc(KEYCTL_SETPERM, key, 0x003f0000L, 0, 0) == 0, "owner-only key permissions");
    child = fork();
    require(child >= 0, "fork permission boundary");
    if (!child) {
        if (setgroups(0, NULL) || setresgid(1000, 1000, 1000) || setresuid(1000, 1000, 1000)) _exit(87);
        errno = 0;
        if (read_key(key, bytes, sizeof bytes) != -1 || errno != EACCES) _exit(88);
        _exit(37);
    }
    wait_child(child);
    require(read_key(key, bytes, sizeof bytes) == sizeof replacement, "owner still reads key");
    long logon = add("logon", "wasm:credential", original, sizeof original);
    require(logon > 0, "logon key creation");
    errno = 0;
    require(read_key(logon, bytes, sizeof bytes) == -1 && errno == EOPNOTSUPP, "logon secret is not readable");
    puts("keyrings: owner permissions and non-readable logon payload pass");
    fflush(stdout);

    child = fork();
    require(child >= 0, "fork exec inheritance");
    if (!child) {
        char key_text[32], ring_text[32];
        snprintf(key_text, sizeof key_text, "%ld", key);
        snprintf(ring_text, sizeof ring_text, "%ld", session);
        char *args[] = {"keyring-helper", key_text, ring_text, NULL};
        char *env[] = {NULL};
        execve("/keyring-helper", args, env);
        _exit(89);
    }
    wait_child(child);
    puts("keyrings: session and updated payload survive ordinary exec pass");
    fflush(stdout);
    require(kc(KEYCTL_REVOKE, key, 0, 0, 0) == 0, "revoke key");
    errno = 0;
    /* A revoked link reports EKEYREVOKED until asynchronous GC removes it. */
    require(find_key(session, "wasm-binary") == -1 && (errno == EKEYREVOKED || errno == ENOKEY),
            "revoked key no longer searchable");
    require(kc(KEYCTL_CLEAR, session, 0, 0, 0) == 0 && read_key(session, NULL, 0) == 0,
            "session links cleaned");
    puts("keyrings: revocation search boundary and final keyring cleanup pass");
    puts("::vm-test::pass");
    fflush(stdout);
#ifdef __wasm__
    for (;;) sched_yield();
#else
    return 0;
#endif
}
