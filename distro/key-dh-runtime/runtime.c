/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <linux/keyctl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef KEYCTL_DH_COMPUTE
#define KEYCTL_DH_COMPUTE 23
#endif

enum { DH_BYTES = 256, PRIVATE_BYTES = 32, INPUTS = 3 };

struct dh_compute_params {
	int32_t private_key;
	int32_t prime;
	int32_t base;
};
_Static_assert(sizeof(struct dh_compute_params) == 12, "keyctl DH parameter ABI");

/* RFC 7919 ffdhe2048 prime, big-endian. */
static const char prime_hex[] =
	"ffffffffffffffffadf85458a2bb4a9aafdc5620273d3cf1d8b9c583ce2d3695"
	"a9e13641146433fbcc939dce249b3ef97d2fe363630c75d8f681b202aec4617a"
	"d3df1ed5d5fd65612433f51f5f066ed0856365553ded1af3b557135e7f57c935"
	"984f0c70e0e68b77e2a689daf3efe8721df158a136ade73530acca4f483a797a"
	"bc0ab182b324fb61d108a94bb2c8e3fbb96adab760d7f4681d4f42a3de394df4"
	"ae56ede76372bb190b07a7c8ee0a6d709e02fce1cdf7e2ecc03404cd28342f61"
	"9172fe9ce98583ff8e4f1232eef28183c3fe3b1b4c6fad733bb5fcbc2ec22005"
	"c58ef1837d1683b2c6f34a26c1b2effa886b423861285c97ffffffffffffffff";

/* xa and xb are fixed test-only scalars; base is 2^xb mod p and expected is
 * base^xa mod p. Both scalar inputs are exactly 32 bytes, big-endian. */
static const char private_hex[] = "6c805af3e99a43fbb7914fed79d67762dfdc5f7ab5c18807d1ba6be395786eca";
static const char base_hex[] =
	"8d5b4f928ae75f646bf62a600e032a909351fbf82b457c1668469f6912a9e68a"
	"f9157a162baa427f384d95fd2fa12909c9c9d34a249a968ee3fe904d9064df69"
	"1386b70d4c80126b04ade948b237370ba43a406eb2b9029f0b3b3f01ccc571c8"
	"d50ea1e0501ea8d17c43bc5d5004e92ce97aec757cd5dcd7e613b884b28554a"
	"1a43a5c6018a795c21ff8986010bac823bf4d97134635c4aa2dcf39fb7faaea"
	"93b9dff0ad99b6ce92bc759c5da2946ddd04bd7b17b18e8d8b5ed601004a113"
	"bc72b1706fdeb0acc5c1bc8da88f9571550b9f302260664208bea254b540a5e"
	"7ee7e170dbe06b5dcaf9fad7473bb372ae9d077debf7c56c69c763e55c910b9a4768";
static const char expected_hex[] =
	"9aba79389cc5f04894c0d6c0f46381ccab4a83cc86bde2500617655a65329cd4"
	"26c4200bd8fb0cf40770bcccb50f13930fa59890610c61df482eca6a7a35eea4"
	"1aa8ffddc1d6ead8f32f08fecab78e2d31b879a0075e3c39ae8ee11c6889584"
	"f2f59a2f8d06c060d764fd6446cfa22f3eba716f143ff2765582e2847d659223"
	"1949910d6f30b0f4537599969472a5d412c450ef321d94346429de6c3fd0f95"
	"ac1d75002829174292f39ee2d719b698856dbd85221b783849672b681ee708e4"
	"f3bb741af1173e2ab33744386e4bb1aeee1f79ebe9453f1d76b42426dc67ef9"
	"fcfb1f91b2e80e7c7e63bf2e4fb47b1ef59d34eb58c59f235a4278f52e575b5bca2";

static int32_t ring_id;
static int32_t key_ids[INPUTS];

static long keyctl_call(long command, unsigned long arg2, unsigned long arg3,
		unsigned long arg4, unsigned long arg5)
{
	return syscall(SYS_keyctl, command, arg2, arg3, arg4, arg5);
}

static int cleanup(void)
{
	int saved_errno = errno;
	int cleanup_errno = 0;
	for (size_t i = 0; i < INPUTS; i++) {
		if (key_ids[i] <= 0)
			continue;
		if (keyctl_call(KEYCTL_REVOKE, (unsigned long)(uint32_t)key_ids[i], 0, 0, 0) < 0 &&
		    !cleanup_errno)
			cleanup_errno = errno;
		if (ring_id > 0)
			if (keyctl_call(KEYCTL_UNLINK, (unsigned long)(uint32_t)key_ids[i],
					 (unsigned long)(uint32_t)ring_id, 0, 0) < 0 &&
			    !cleanup_errno)
				cleanup_errno = errno;
	}
	if (ring_id > 0 &&
	    keyctl_call(KEYCTL_CLEAR, (unsigned long)(uint32_t)ring_id, 0, 0, 0) < 0 &&
	    !cleanup_errno)
		cleanup_errno = errno;
	errno = cleanup_errno ? cleanup_errno : saved_errno;
	return cleanup_errno ? -1 : 0;
}

static void fail(const char *what)
{
	int saved_errno = errno;
	(void)cleanup();
#if !defined(__wasm__)
	if (saved_errno == EPERM) {
		puts("key DH runtime: skipped (host keyring permission denied)");
		fflush(stdout);
		exit(77);
	}
#endif
	errno = saved_errno;
	printf("::vm-test::fail: key DH runtime: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}

#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)

static unsigned hex_nibble(char c)
{
	if (c >= '0' && c <= '9')
		return (unsigned)(c - '0');
	CHECK(c >= 'a' && c <= 'f', "hex vector character");
	return (unsigned)(c - 'a' + 10);
}

static void decode_hex(unsigned char *out, const char *hex, size_t size)
{
	CHECK(strlen(hex) == size * 2, "fixed vector length");
	for (size_t i = 0; i < size; i++)
		out[i] = (unsigned char)((hex_nibble(hex[2 * i]) << 4) |
					 hex_nibble(hex[2 * i + 1]));
}

static int32_t add_user_key(const char *description, const void *payload, size_t size)
{
	long id = syscall(SYS_add_key, (unsigned long)(uintptr_t)"user",
			  (unsigned long)(uintptr_t)description,
			  (unsigned long)(uintptr_t)payload, (unsigned long)size,
			  (unsigned long)(uint32_t)ring_id);
	if (id <= 0 || id > INT32_MAX)
		fail("add user key");
	return (int32_t)id;
}

static void expect_shared_secret(const unsigned char *expected)
{
	unsigned char output[DH_BYTES];
	memset(output, 0xa5, sizeof(output));
	struct dh_compute_params params = {
		.private_key = key_ids[0],
		.prime = key_ids[1],
		.base = key_ids[2],
	};
	long result = keyctl_call(KEYCTL_DH_COMPUTE,
				  (unsigned long)(uintptr_t)&params,
				  (unsigned long)(uintptr_t)output,
				  sizeof(output), 0);
	if (result < 0)
		fail("KEYCTL_DH_COMPUTE without KDF");
	CHECK(result == DH_BYTES, "shared secret length");
	CHECK(memcmp(output, expected, DH_BYTES) == 0, "FFDHE2048 shared secret bytes");
}

int main(void)
{
	unsigned char prime[DH_BYTES], base[DH_BYTES], private_key[PRIVATE_BYTES];
	unsigned char expected[DH_BYTES];
	decode_hex(prime, prime_hex, sizeof(prime));
	decode_hex(base, base_hex, sizeof(base));
	decode_hex(private_key, private_hex, sizeof(private_key));
	decode_hex(expected, expected_hex, sizeof(expected));

	long ring = keyctl_call(KEYCTL_JOIN_SESSION_KEYRING, 0, 0, 0, 0);
	if (ring <= 0 || ring > INT32_MAX)
		fail("anonymous session keyring");
	ring_id = (int32_t)ring;
	key_ids[0] = add_user_key("dh-private", private_key, sizeof(private_key));
	key_ids[1] = add_user_key("dh-prime", prime, sizeof(prime));
	key_ids[2] = add_user_key("dh-base", base, sizeof(base));

	expect_shared_secret(expected);
	CHECK(!cleanup(), "revoke keys and clear anonymous session keyring");
	memset(key_ids, 0, sizeof(key_ids));
	ring_id = 0;
	puts("KEY_DH_COMPUTE_OK");
	return 0;
}
