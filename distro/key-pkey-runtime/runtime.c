// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/keyctl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

enum { CertificateCapacity = 4096 };

_Static_assert(sizeof(struct keyctl_pkey_query) == 56, "unexpected keyctl_pkey_query layout");

static int fail(const char *stage)
{
    const int error = errno;
    fprintf(stderr, "public-key query: %s failed errno=%d\n", stage, error);
    printf("::vm-test::fail: public-key query: %s errno=%d\n", stage, error);
    return 1;
}

static long keyctl(long command, long arg2, long arg3, long arg4, long arg5)
{
    return syscall(SYS_keyctl, command, arg2, arg3, arg4, arg5);
}

static int read_certificate(const char *path, unsigned char *buffer, size_t capacity, size_t *length)
{
    const int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) {
        return -1;
    }

    struct stat attributes;
    if (fstat(fd, &attributes) != 0) {
        const int saved_errno = errno;
        (void)close(fd);
        errno = saved_errno;
        return -1;
    }
    if (attributes.st_size <= 0 || (uint64_t)attributes.st_size > capacity) {
        (void)close(fd);
        errno = EINVAL;
        return -1;
    }

    const size_t expected = (size_t)attributes.st_size;
    size_t offset = 0;
    while (offset < expected) {
        const ssize_t result = read(fd, buffer + offset, expected - offset);
        if (result < 0 && errno == EINTR) {
            continue;
        }
        if (result <= 0) {
            const int saved_errno = result == 0 ? EIO : errno;
            (void)close(fd);
            errno = saved_errno;
            return -1;
        }
        offset += (size_t)result;
    }

    if (close(fd) != 0) {
        return -1;
    }
    *length = offset;
    return 0;
}

static int private_key_roundtrip(const char *path, long ring)
{
    unsigned char key_blob[CertificateCapacity];
    size_t key_length = 0;
    if (read_certificate(path, key_blob, sizeof(key_blob), &key_length) != 0) {
        return fail("read test PKCS8 key");
    }
    const long key_id = syscall(SYS_add_key, (long)"asymmetric", (long)"private-key-roundtrip-test", (long)key_blob,
                               (long)key_length, ring);
    memset(key_blob, 0, sizeof(key_blob));
    if (key_id < 0) {
        return fail("add test PKCS8 private key");
    }

    struct keyctl_pkey_query query = {0};
    if (keyctl(KEYCTL_PKEY_QUERY, key_id, 0, (long)"", (long)&query) != 0) {
        return fail("query test private key");
    }
    const unsigned operations = KEYCTL_SUPPORTS_ENCRYPT | KEYCTL_SUPPORTS_DECRYPT;
    if ((query.supported_ops & operations) != operations || query.key_size != 2048 || query.max_enc_size != 256 ||
        query.max_dec_size != 256) {
        errno = EPROTO;
        return fail("private key capabilities");
    }

    unsigned char ciphertext[256] = {0};
    unsigned char plaintext[256] = {0};
    const unsigned char input = 2;
    struct keyctl_pkey_params params = {0};
    params.key_id = (int32_t)key_id;
    params.in_len = sizeof(input);
    params.out_len = sizeof(ciphertext);
    const long encrypted = keyctl(KEYCTL_PKEY_ENCRYPT, (long)&params, (long)"", (long)&input, (long)ciphertext);
    if (encrypted <= 0 || (unsigned long)encrypted > sizeof(ciphertext)) {
        return fail("raw RSA encryption");
    }
    params.in_len = (uint32_t)encrypted;
    params.out_len = sizeof(plaintext);
    const long decrypted = keyctl(KEYCTL_PKEY_DECRYPT, (long)&params, (long)"", (long)ciphertext, (long)plaintext);
    if (decrypted <= 0 || (unsigned long)decrypted > sizeof(plaintext)) {
        return fail("raw RSA decryption");
    }
    for (long index = 0; index < decrypted - 1; ++index) {
        if (plaintext[index] != 0) {
            errno = EPROTO;
            return fail("RSA roundtrip leading bytes");
        }
    }
    if (plaintext[decrypted - 1] != input) {
        errno = EPROTO;
        return fail("RSA roundtrip value");
    }
    if (keyctl(KEYCTL_UNLINK, key_id, ring, 0, 0) != 0) {
        return fail("unlink test private key");
    }
    puts("KEY_PKEY_PKCS8_ROUNDTRIP_OK");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 3) {
        errno = EINVAL;
        return fail("certificate argument");
    }

    unsigned char certificate[CertificateCapacity];
    size_t certificate_length = 0;
    if (read_certificate(argv[1], certificate, sizeof(certificate), &certificate_length) != 0) {
        return fail("read DER certificate");
    }

    char ring_name[32];
    const int name_length = snprintf(ring_name, sizeof(ring_name), "pkey-query-%ld", (long)getpid());
    if (name_length < 0 || (size_t)name_length >= sizeof(ring_name)) {
        errno = EOVERFLOW;
        return fail("format session keyring name");
    }

    const long ring = keyctl(KEYCTL_JOIN_SESSION_KEYRING, (long)ring_name, 0, 0, 0);
    if (ring < 0) {
        return fail("join isolated session keyring");
    }
    const long key_id = syscall(SYS_add_key, (long)"asymmetric", (long)"public-key-query-test", (long)certificate,
                               (long)certificate_length, ring);
    if (key_id < 0) {
        return fail("add X.509 public key");
    }

    struct keyctl_pkey_query query;
    memset(&query, 0xa5, sizeof(query));
    if (keyctl(KEYCTL_PKEY_QUERY, key_id, 0, (long)"", (long)&query) != 0) {
        return fail("query RSA public-key capabilities");
    }

    if (query.supported_ops != KEYCTL_SUPPORTS_ENCRYPT || query.key_size != 2048 || query.max_data_size != 256 ||
        query.max_sig_size != 256 || query.max_enc_size != 256 || query.max_dec_size != 256) {
        errno = EPROTO;
        return fail("unexpected RSA query fields");
    }
    for (size_t index = 0; index < sizeof(query.__spare) / sizeof(query.__spare[0]); ++index) {
        if (query.__spare[index] != 0) {
            errno = EPROTO;
            return fail("nonzero query reserved word");
        }
    }

    errno = 0;
    if (keyctl(KEYCTL_PKEY_QUERY, key_id, 1, (long)UINTPTR_MAX, (long)UINTPTR_MAX) != -1 || errno != EINVAL) {
        errno = EPROTO;
        return fail("reserved argument validation order");
    }

    printf("PKEY_QUERY_RESULT ops=%u bits=%u data=%u sig=%u enc=%u dec=%u spare=zero\n", query.supported_ops, query.key_size,
           query.max_data_size, query.max_sig_size, query.max_enc_size, query.max_dec_size);
    puts("KEY_PKEY_QUERY_OK");
    return private_key_roundtrip(argv[2], ring);
}
