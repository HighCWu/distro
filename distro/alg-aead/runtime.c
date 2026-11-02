/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/if_alg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void fail(const char *what)
{
	printf("::vm-test::fail: AF_ALG AEAD: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)

static void close_fd(int fd)
{
	CHECK(!close(fd), "close descriptor");
	errno = 0;
	CHECK(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "descriptor released");
}

static int parent(void)
{
	struct sockaddr_alg address = {.salg_family = AF_ALG};
	strcpy((char *)address.salg_type, "aead");
	strcpy((char *)address.salg_name, "gcm(aes)");
	int fd = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	CHECK(fd >= 0, "AEAD parent socket");
	CHECK(!bind(fd, (struct sockaddr *)&address, sizeof(address)), "standard GCM name");
	unsigned char key[16] = {0};
	errno = 0;
	CHECK(setsockopt(fd, SOL_ALG, ALG_SET_KEY, key, 15) == -1 && errno == EINVAL, "invalid key size");
	CHECK(!setsockopt(fd, SOL_ALG, ALG_SET_KEY, key, sizeof(key)), "AES-128 key");
	errno = 0;
	CHECK(setsockopt(fd, SOL_ALG, ALG_SET_AEAD_AUTHSIZE, NULL, 1) == -1 && errno == EINVAL, "invalid tag size");
	CHECK(!setsockopt(fd, SOL_ALG, ALG_SET_AEAD_AUTHSIZE, NULL, 16), "16-byte tag");
	return fd;
}

static int operation(int fd)
{
	int op = accept4(fd, NULL, NULL, SOCK_CLOEXEC);
	CHECK(op >= 0 && (fcntl(op, F_GETFD) & FD_CLOEXEC), "accept record operation");
	return op;
}

static void submit(int op, unsigned direction, const void *bytes, size_t size,
		   uint32_t aad)
{
	union {
		struct cmsghdr alignment;
		unsigned char bytes[CMSG_SPACE(sizeof(uint32_t)) * 2 +
			CMSG_SPACE(sizeof(struct af_alg_iv) + 12)];
	} control = {0};
	struct iovec input = {(void *)bytes, size};
	struct msghdr message = {.msg_control = control.bytes,
		.msg_controllen = sizeof(control.bytes), .msg_iov = &input, .msg_iovlen = 1};
	struct cmsghdr *cmsg = CMSG_FIRSTHDR(&message);
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_OP;
	cmsg->cmsg_len = CMSG_LEN(sizeof(uint32_t));
	uint32_t value = direction;
	memcpy(CMSG_DATA(cmsg), &value, sizeof(value));
	cmsg = (void *)(control.bytes + CMSG_SPACE(sizeof(uint32_t)));
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_IV;
	cmsg->cmsg_len = CMSG_LEN(sizeof(struct af_alg_iv) + 12);
	struct af_alg_iv *iv = (void *)CMSG_DATA(cmsg);
	iv->ivlen = 12; /* Fixed all-zero nonce for the known-answer fixtures. */
	cmsg = (void *)(control.bytes + CMSG_SPACE(sizeof(uint32_t)) +
		CMSG_SPACE(sizeof(struct af_alg_iv) + 12));
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_AEAD_ASSOCLEN;
	cmsg->cmsg_len = CMSG_LEN(sizeof(aad));
	memcpy(CMSG_DATA(cmsg), &aad, sizeof(aad));
	CHECK(sendmsg(op, &message, 0) == (ssize_t)size, "submit complete authentication record");
}

static void receive_record(int op, unsigned char *output, size_t size)
{
	/* Surround the receive range, including the zero-plaintext case. */
	size_t requested = size ? size : 1;
	memset(output, 0xa5, requested + 2);
	size_t first = requested > 17 ? 17 : requested;
	struct iovec vectors[] = {{output + 1, first},
		{output + 1 + first, requested - first}};
	struct msghdr message = {.msg_iov = vectors, .msg_iovlen = 2};
	CHECK(recvmsg(op, &message, 0) == (ssize_t)size, "receive authenticated record");
	CHECK(output[0] == 0xa5 && output[requested + 1] == 0xa5, "record destination guards");
	if (!size)
		CHECK(output[1] == 0xa5, "empty plaintext has no destination write");
}

static void hex_equal(const unsigned char *bytes, size_t size, const char *expected)
{
	static const char hex[] = "0123456789abcdef";
	CHECK(strlen(expected) == 2 * size, "known-answer size");
	for (size_t i = 0; i < size; i++)
		CHECK(hex[bytes[i] >> 4] == expected[2 * i] &&
		      hex[bytes[i] & 15] == expected[2 * i + 1], "independent known-answer bytes");
}

static void digest_equal(const void *bytes, size_t size, const char *expected)
{
	struct sockaddr_alg address = {.salg_family = AF_ALG};
	strcpy((char *)address.salg_type, "hash");
	strcpy((char *)address.salg_name, "sha256");
	int fd = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	CHECK(fd >= 0 && !bind(fd, (struct sockaddr *)&address, sizeof(address)), "SHA-256 verifier");
	int op = operation(fd);
	CHECK(send(op, bytes, size, 0) == (ssize_t)size, "hash complete ciphertext record");
	unsigned char digest[32];
	CHECK(recv(op, digest, sizeof(digest), 0) == sizeof(digest), "record digest");
	hex_equal(digest, sizeof(digest), expected);
	close_fd(op);
	close_fd(fd);
}

static void large_record(int fd, size_t aad, size_t plaintext, const char *digest)
{
	size_t input_size = aad + plaintext, output_size = input_size + 16;
	unsigned char *input = malloc(input_size), *encrypted = malloc(output_size + 2);
	unsigned char *decrypted = malloc(input_size + 2);
	CHECK(input && encrypted && decrypted, "multi-page record allocation");
	for (size_t i = 0; i < aad; i++) input[i] = (unsigned char)(i * 37 + 11);
	for (size_t i = 0; i < plaintext; i++) input[aad + i] = (unsigned char)(i * 13 + 3);
	int op = operation(fd);
	submit(op, ALG_OP_ENCRYPT, input, input_size, aad);
	receive_record(op, encrypted, output_size);
	CHECK(!memcmp(encrypted + 1, input, aad), "AAD preserved in output");
	digest_equal(encrypted + 1, output_size, digest);
	submit(op, ALG_OP_DECRYPT, encrypted + 1, output_size, aad);
	receive_record(op, decrypted, input_size);
	CHECK(!memcmp(decrypted + 1, input, input_size), "authenticated multi-page plaintext and AAD");
	close_fd(op);
	free(input); free(encrypted); free(decrypted);
}

int main(void)
{
	int fd = parent(), op = operation(fd);
	unsigned char zero[16] = {0}, encrypted[34], decrypted[18];
	submit(op, ALG_OP_ENCRYPT, zero, 0, 0);
	receive_record(op, encrypted, 16);
	hex_equal(encrypted + 1, 16, "58e2fccefa7e3061367f1d57a4e7455a");
	submit(op, ALG_OP_DECRYPT, encrypted + 1, 16, 0);
	receive_record(op, decrypted, 0);
	submit(op, ALG_OP_ENCRYPT, zero, sizeof(zero), 0);
	receive_record(op, encrypted, 32);
	hex_equal(encrypted + 1, 32, "0388dace60b6a392f328c2b971b2fe78ab6e47d42cec13bdf53a67b21257bddf");
	submit(op, ALG_OP_DECRYPT, encrypted + 1, 32, 0);
	receive_record(op, decrypted, 16);
	CHECK(!memcmp(decrypted + 1, zero, 16), "NIST plaintext");
	puts("AF_ALG AEAD: AES-GCM NIST vectors, empty records and standard controls pass");

	large_record(fd, 65539, 17, "07eecb1b3f629c6e7ca735cbb5f077c2ece748180891f3e06b19d02a94815c2b");
	large_record(fd, 23, 65553, "6727771759ca5150dccdcd2e587476cb555e5dacd5c10496920cfdd9f799c1a8");
	puts("AF_ALG AEAD: multi-page AAD/plaintext, independent ciphertext digests and authenticated round trips pass");

	encrypted[32] ^= 1;
	submit(op, ALG_OP_DECRYPT, encrypted + 1, 32, 0);
	memset(decrypted, 0xa5, sizeof(decrypted));
	errno = 0;
	CHECK(recv(op, decrypted + 1, 16, 0) == -1 && errno == EBADMSG, "authentication failure");
	for (size_t i = 0; i < sizeof(decrypted); i++)
		CHECK(decrypted[i] == 0xa5, "no unauthenticated plaintext delivery");
	encrypted[32] ^= 1;
	submit(op, ALG_OP_DECRYPT, encrypted + 1, 32, 0);
	receive_record(op, decrypted, 16);
	CHECK(!memcmp(decrypted + 1, zero, 16), "same-operation recovery after bad tag");
	submit(op, ALG_OP_DECRYPT, encrypted + 1, 32, 0);
	volatile uintptr_t invalid = UINTPTR_MAX - 4095;
	errno = 0;
	CHECK(recv(op, (void *)invalid, 16, MSG_DONTWAIT) == -1 && errno == EFAULT, "invalid linear-memory destination");
	receive_record(op, decrypted, 16);
	CHECK(!memcmp(decrypted + 1, zero, 16), "destination fault preserves queued authenticated input");
	close_fd(op);
	close_fd(fd);
	puts("AF_ALG AEAD: bad-tag isolation, destination-fault recovery and descriptor cleanup pass");
	return 0;
}
