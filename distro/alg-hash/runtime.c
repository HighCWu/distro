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
	printf("::vm-test::fail: AF_ALG hash: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)
static const char abc[] = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
static void digest(int fd, const char *expected)
{
	unsigned char bytes[34];
	memset(bytes, 0xa5, sizeof(bytes));
	CHECK(recv(fd, bytes + 1, 32, 0) == 32, "receive digest");
	CHECK(bytes[0] == 0xa5 && bytes[33] == 0xa5, "digest guards");
	for (unsigned i = 0; i < 32; i++) {
		static const char hex[] = "0123456789abcdef";
		CHECK(hex[bytes[i + 1] >> 4] == expected[2 * i] &&
		      hex[bytes[i + 1] & 15] == expected[2 * i + 1], "known digest bytes");
	}
}
static int parent(const char *name)
{
	struct sockaddr_alg address = {.salg_family = AF_ALG};
	_Static_assert(sizeof(struct sockaddr_alg) == 88, "Linux AF_ALG address ABI");
	memcpy(address.salg_type, "hash", 5);
	CHECK(strlen(name) < sizeof(address.salg_name), "algorithm name bound");
	strcpy((char *)address.salg_name, name);
	int fd = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	CHECK(fd >= 0 && (fcntl(fd, F_GETFD) & FD_CLOEXEC), "algorithm socket");
	CHECK(!bind(fd, (struct sockaddr *)&address, sizeof(address)), "bind standard hash name");
	return fd;
}
static int operation(int fd)
{
	int child = accept4(fd, NULL, NULL, SOCK_CLOEXEC);
	CHECK(child >= 0 && (fcntl(child, F_GETFD) & FD_CLOEXEC), "accept operation socket");
	return child;
}
static void close_fd(int fd)
{
	CHECK(!close(fd), "close descriptor");
	errno = 0;
	CHECK(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "descriptor released");
}
int main(void)
{
	int fd = parent("sha256"), op = operation(fd);
	CHECK(send(op, "abc", 3, 0) == 3, "one-shot input");
	digest(op, abc);
	CHECK(send(op, "", 0, 0) == 0, "empty input");
	digest(op, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	CHECK(send(op, "a", 1, MSG_MORE) == 1, "begin incremental hash");
	int cloned = operation(op);
	CHECK(send(op, "bc", 2, 0) == 2 && send(cloned, "bc", 2, 0) == 2,
	      "independent accepted hash state");
	digest(op, abc);
	digest(cloned, abc);
	close_fd(cloned);
	puts("AF_ALG hash: SHA-256 known vectors, empty input and incremental state cloning pass");

	enum { LENGTH = 1048593 };
	unsigned char *data = malloc(LENGTH);
	CHECK(data, "large binary input allocation");
	for (size_t i = 0; i < LENGTH; i++) data[i] = (unsigned char)(i * 37 + 11);
	struct iovec vectors[] = {{data, 17}, {data + 17, 65536},
		{data + 17 + 65536, LENGTH - 17 - 65536}};
	struct msghdr message = {.msg_iov = vectors, .msg_iovlen = 3};
	CHECK(sendmsg(op, &message, 0) == LENGTH, "multi-page vector input");
	digest(op, "f29a3c3c1b0a783a1e51a92b74707d00ff6fbedc83ccc862a5c65b61c2f06064");
	free(data);
	CHECK(send(op, "abc", 3, 0) == 3, "truncated digest input");
	unsigned char short_digest[10];
	memset(short_digest, 0xa5, sizeof(short_digest));
	struct iovec short_vector = {short_digest + 1, 8};
	message = (struct msghdr){.msg_iov = &short_vector, .msg_iovlen = 1};
	CHECK(recvmsg(op, &message, 0) == 8 && (message.msg_flags & MSG_TRUNC), "digest truncation");
	CHECK(!memcmp(short_digest + 1, "\xba\x78\x16\xbf\x8f\x01\xcf\xea", 8) &&
	      short_digest[0] == 0xa5 && short_digest[9] == 0xa5, "truncated bytes and guards");
#ifdef __wasm__
	/* In-range architecture offset, but no byte exists there in this memory. */
	uintptr_t end = __builtin_wasm_memory_size(0) * (uintptr_t)65536;
	CHECK(end <= UINTPTR_MAX - 32, "fault address arithmetic");
	errno = 0;
	CHECK(send(op, (void *)end, 16, 0) == -1 && errno == EFAULT, "invalid input memory");
	CHECK(send(op, "abc", 3, 0) == 3, "recover after input fault");
	digest(op, abc);
	CHECK(send(op, "abc", 3, 0) == 3, "output fault input");
	errno = 0;
	CHECK(recv(op, (void *)end, 32, 0) == -1 && errno == EFAULT, "invalid digest memory");
	CHECK(send(op, "abc", 3, 0) == 3, "recover after output fault");
	digest(op, abc);
#endif
	close_fd(op);
	close_fd(fd);
	puts("AF_ALG hash: bounded binary vectors, truncation, address errors and recovery pass");

	fd = parent("hmac(sha256)");
	unsigned char key[20];
	memset(key, 0x0b, sizeof(key));
	CHECK(!setsockopt(fd, SOL_ALG, ALG_SET_KEY, key, sizeof(key)), "HMAC standard key option");
	op = operation(fd);
	CHECK(send(op, "Hi There", 8, 0) == 8, "HMAC input");
	digest(op, "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
	close_fd(op);
	close_fd(fd);
	puts("AF_ALG hash: RFC 4231 HMAC-SHA256 and descriptor cleanup pass");
	return 0;
}
