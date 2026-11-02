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

enum { LARGE = 65536 + 64 };
static const char key_hex[] = "2b7e151628aed2a6abf7158809cf4f3c";
static const char iv_hex[] = "000102030405060708090a0b0c0d0e0f";
static const char plain_hex[] =
	"6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e51"
	"30c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710";
static const char cbc_hex[] =
	"7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b2"
	"73bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7";
static void fail(const char *what)
{
	printf("::vm-test::fail: AF_ALG skcipher: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)
static unsigned nibble(char c)
{
	if (c >= '0' && c <= '9') return (unsigned)(c - '0');
	CHECK(c >= 'a' && c <= 'f', "hex fixture digit");
	return (unsigned)(c - 'a' + 10);
}
static void decode(unsigned char *out, const char *hex, size_t n)
{
	CHECK(strlen(hex) == 2 * n, "hex fixture length");
	for (size_t i = 0; i < n; i++) out[i] = (unsigned char)((nibble(hex[2 * i]) << 4) | nibble(hex[2 * i + 1]));
}
static void matches(const unsigned char *bytes, const char *hex, size_t n)
{
	CHECK(strlen(hex) == 2 * n, "expected fixture length");
	for (size_t i = 0; i < n; i++)
		CHECK(bytes[i] == ((nibble(hex[2 * i]) << 4) | nibble(hex[2 * i + 1])), "ciphertext fixture bytes");
}
static void close_fd(int fd)
{
	CHECK(!close(fd), "close socket");
	errno = 0;
	CHECK(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "released descriptor");
}
static int operation(const char *name)
{
	struct sockaddr_alg address = {.salg_family = AF_ALG};
	memcpy(address.salg_type, "skcipher", 9);
	CHECK(strlen(name) < sizeof(address.salg_name), "algorithm name bound");
	strcpy((char *)address.salg_name, name);
	int fd = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	CHECK(fd >= 0, "skcipher parent socket");
	CHECK(!bind(fd, (struct sockaddr *)&address, sizeof(address)), "bind cipher");
	unsigned char key[16];
	decode(key, key_hex, sizeof(key));
	errno = 0;
	CHECK(setsockopt(fd, SOL_ALG, ALG_SET_KEY, key, 15) == -1 && errno == EINVAL, "invalid AES key length");
	CHECK(!setsockopt(fd, SOL_ALG, ALG_SET_KEY, key, sizeof(key)), "AES key");
	int op = accept4(fd, NULL, NULL, SOCK_CLOEXEC);
	CHECK(op >= 0 && (fcntl(op, F_GETFD) & FD_CLOEXEC), "accept cipher operation");
	int capacity = 262144;
	socklen_t length = sizeof(capacity);
	CHECK(!setsockopt(op, SOL_SOCKET, SO_SNDBUF, &capacity, sizeof(capacity)), "cipher send capacity");
	CHECK(!getsockopt(op, SOL_SOCKET, SO_SNDBUF, &capacity, &length) &&
	      length == sizeof(capacity) && capacity / 65536 * 65536 >= LARGE,
	      "queued record fits before synchronous receive");
	close_fd(fd);
	return op;
}
static void send_record(int op, const void *bytes, size_t size, int encrypt, const char *iv)
{
	union {
		struct cmsghdr align;
		unsigned char bytes[CMSG_SPACE(sizeof(uint32_t)) + CMSG_SPACE(sizeof(struct af_alg_iv) + 16)];
	} control = {0};
	struct iovec vector = {(void *)bytes, size};
	struct msghdr message = {.msg_iov = &vector, .msg_iovlen = 1,
		.msg_control = control.bytes, .msg_controllen = sizeof(control.bytes)};
	struct cmsghdr *header = CMSG_FIRSTHDR(&message);
	header->cmsg_level = SOL_ALG;
	header->cmsg_type = ALG_SET_OP;
	header->cmsg_len = CMSG_LEN(sizeof(uint32_t));
	uint32_t direction = encrypt ? ALG_OP_ENCRYPT : ALG_OP_DECRYPT;
	memcpy(CMSG_DATA(header), &direction, sizeof(direction));
	header = (void *)(control.bytes + CMSG_SPACE(sizeof(uint32_t)));
	header->cmsg_level = SOL_ALG;
	header->cmsg_type = ALG_SET_IV;
	header->cmsg_len = CMSG_LEN(sizeof(struct af_alg_iv) + 16);
	struct af_alg_iv *value = (void *)CMSG_DATA(header);
	value->ivlen = 16;
	decode(value->iv, iv, 16);
	CHECK(sendmsg(op, &message, 0) == (ssize_t)size, "queue cipher input and controls");
}
static void receive(int op, unsigned char *out, size_t size)
{
	struct iovec vectors[] = {{out, 3}, {out + 3, size - 3}};
	struct msghdr message = {.msg_iov = vectors, .msg_iovlen = 2};
	CHECK(size >= 3 && recvmsg(op, &message, 0) == (ssize_t)size, "receive vector cipher result");
}
int main(void)
{
	unsigned char plain[64], cipher[66];
	decode(plain, plain_hex, sizeof(plain));
	int op = operation("cbc(aes)");
	memset(cipher, 0xa5, sizeof(cipher));
	send_record(op, plain, sizeof(plain), 1, iv_hex);
	receive(op, cipher + 1, 64);
	matches(cipher + 1, cbc_hex, 64);
	CHECK(cipher[0] == 0xa5 && cipher[65] == 0xa5, "cipher output guards");
	send_record(op, cipher + 1, 64, 0, iv_hex);
	receive(op, cipher + 1, 64);
	CHECK(!memcmp(cipher + 1, plain, 64), "CBC known-vector decryption");
	puts("AF_ALG skcipher: AES-CBC fixed encryption/decryption vectors and ancillary controls pass");

	unsigned char *large = malloc(LARGE), *output = malloc(LARGE + 2);
	CHECK(large && output, "cross-page buffers");
	for (size_t i = 0; i < LARGE; i++) large[i] = (unsigned char)(i * 37 + 11);
	memset(output, 0xa5, LARGE + 2);
	send_record(op, large, LARGE, 1, iv_hex);
	receive(op, output + 1, LARGE);
	CHECK(output[0] == 0xa5 && output[LARGE + 1] == 0xa5, "cross-page guards");
	/* Independent OpenSSL AES-128-CBC reference, no padding, the pattern above. */
	matches(output + 1, "f9cf35905947cde981c2c2072550f3d7db7e4f81406a74ee68ba4b58d1ef25ca4e5cce6cf3c0a86249eb01a17c27e1bcf8e1d6702a7b19e1b7f09639cc4624d1", 64);
	matches(output + 1 + 65536 - 16, "bcbddc93151221da89f8535f4dd429f562a380c191f350f04b7c7b9e96b830b71a0196618819d20a5bc4184fe0ee22ff94dd166f15fa3eb8680820ac301dda75f9428895756baf738d7a013795f197fd", 80);
	send_record(op, output + 1, LARGE, 0, iv_hex);
	receive(op, large, LARGE);
	for (size_t i = 0; i < LARGE; i++) CHECK(large[i] == (unsigned char)(i * 37 + 11), "cross-page decrypt bytes");
	free(output);
	free(large);
	puts("AF_ALG skcipher: bounded cross-page CBC output and independent chaining bytes pass");

#ifdef __wasm__
	send_record(op, plain, 64, 1, iv_hex);
	uintptr_t end = __builtin_wasm_memory_size(0) * (uintptr_t)65536;
	CHECK(end <= UINTPTR_MAX - 64, "invalid output address arithmetic");
	errno = 0;
	CHECK(recv(op, (void *)end, 64, 0) == -1 && errno == EFAULT, "invalid destination before input consumption");
	receive(op, cipher + 1, 64);
	matches(cipher + 1, cbc_hex, 64);
#endif
	send_record(op, plain, 17, 1, iv_hex);
	errno = 0;
	CHECK(recv(op, cipher + 1, 17, 0) == -1 && errno == EINVAL, "CBC non-block-size rejection");
	send_record(op, plain, 64, 1, iv_hex);
	receive(op, cipher + 1, 64);
	matches(cipher + 1, cbc_hex, 64);
	close_fd(op);
	op = operation("ctr(aes)");
	send_record(op, plain, 17, 1, "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
	receive(op, cipher + 1, 17);
	matches(cipher + 1, "874d6191b620e3261bef6864990db6ce98", 17);
	send_record(op, cipher + 1, 17, 0, "f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
	receive(op, cipher + 1, 17);
	CHECK(!memcmp(cipher + 1, plain, 17), "CTR partial-block decryption");
	close_fd(op);
	puts("AF_ALG skcipher: address/length errors, recovery, CTR partial blocks and descriptor cleanup pass");
	return 0;
}
