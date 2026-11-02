/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/cryptouser.h>
#include <linux/if_alg.h>
#include <linux/netlink.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void fail(const char *what)
{
	printf("::vm-test::fail: NETLINK_CRYPTO: %s errno=%d\n", what, errno);
	fflush(stdout);
	exit(1);
}
#define CHECK(ok, what) do { if (!(ok)) fail(what); } while (0)

static uint32_t sequence, port;
static union {
	struct nlmsghdr alignment;
	unsigned char bytes[65536];
} response;

static void close_fd(int fd)
{
	CHECK(!close(fd), "close descriptor");
	errno = 0;
	CHECK(fcntl(fd, F_GETFD) == -1 && errno == EBADF, "descriptor released");
}

/* As in libkcapi, instantiate through AF_ALG before asking for its metadata. */
static void activate(const char *type, const char *name)
{
	struct sockaddr_alg address = {.salg_family = AF_ALG};
	CHECK(strlen(type) < sizeof(address.salg_type) &&
	      strlen(name) < sizeof(address.salg_name), "AF_ALG name bounds");
	strcpy((char *)address.salg_type, type);
	strcpy((char *)address.salg_name, name);
	int fd = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	CHECK(fd >= 0, "AF_ALG socket");
	CHECK(!bind(fd, (struct sockaddr *)&address, sizeof(address)), "instantiate algorithm");
	close_fd(fd);
}

static int open_netlink(void)
{
	struct sockaddr_nl address = {.nl_family = AF_NETLINK};
	int fd = socket(AF_NETLINK, SOCK_RAW | SOCK_CLOEXEC, NETLINK_CRYPTO);
	CHECK(fd >= 0 && (fcntl(fd, F_GETFD) & FD_CLOEXEC), "crypto Netlink socket");
	CHECK(!bind(fd, (struct sockaddr *)&address, sizeof(address)), "auto-bind port");
	socklen_t size = sizeof(address);
	CHECK(!getsockname(fd, (struct sockaddr *)&address, &size) &&
	      size == sizeof(address) && address.nl_family == AF_NETLINK &&
	      address.nl_pid && !address.nl_groups, "bound Netlink identity");
	port = address.nl_pid;
	return fd;
}

static void report(const struct nlmsghdr *header, const char *expected,
		   int *hash_seen, int *cipher_seen)
{
	CHECK(header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct crypto_user_alg)), "report header length");
	const struct crypto_user_alg *algorithm = NLMSG_DATA(header);
	CHECK(memchr(algorithm->cru_name, 0, sizeof(algorithm->cru_name)) &&
	      memchr(algorithm->cru_driver_name, 0, sizeof(algorithm->cru_driver_name)) &&
	      memchr(algorithm->cru_module_name, 0, sizeof(algorithm->cru_module_name)), "terminated algorithm names");
	if (expected)
		CHECK(!strcmp(algorithm->cru_name, expected), "requested algorithm identity");
	size_t offset = NLMSG_LENGTH(sizeof(*algorithm));
	int found = 0;
	while (offset < header->nlmsg_len) {
		size_t left = header->nlmsg_len - offset;
		CHECK(left >= NLA_HDRLEN, "attribute header bounds");
		const struct nlattr *attribute = (const void *)((const unsigned char *)header + offset);
		CHECK(attribute->nla_len >= NLA_HDRLEN && attribute->nla_len <= left &&
		      (size_t)NLA_ALIGN(attribute->nla_len) <= left, "attribute payload bounds");
		const void *data = (const unsigned char *)attribute + NLA_HDRLEN;
		if (attribute->nla_type == CRYPTOCFGA_REPORT_HASH &&
		    !strcmp(algorithm->cru_name, "sha256")) {
			CHECK(attribute->nla_len == NLA_HDRLEN + sizeof(struct crypto_report_hash), "hash report size");
			const struct crypto_report_hash *hash = data;
			CHECK(memchr(hash->type, 0, sizeof(hash->type)) &&
			      (!strcmp(hash->type, "shash") || !strcmp(hash->type, "ahash")) &&
			      hash->blocksize == 64 && hash->digestsize == 32, "SHA-256 metadata");
			*hash_seen = found = 1;
		}
		if (attribute->nla_type == CRYPTOCFGA_REPORT_BLKCIPHER &&
		    !strcmp(algorithm->cru_name, "cbc(aes)")) {
			CHECK(attribute->nla_len == NLA_HDRLEN + sizeof(struct crypto_report_blkcipher), "cipher report size");
			const struct crypto_report_blkcipher *cipher = data;
			printf("NETLINK_CRYPTO metadata: CBC-AES backend=%.64s block=%u key=%u..%u iv=%u\n",
			       cipher->type, cipher->blocksize, cipher->min_keysize,
			       cipher->max_keysize, cipher->ivsize);
			CHECK(memchr(cipher->type, 0, sizeof(cipher->type)) &&
			      (!strcmp(cipher->type, "skcipher") || !strcmp(cipher->type, "lskcipher")) &&
			      cipher->blocksize == 16 &&
			      cipher->min_keysize == 16 && cipher->max_keysize == 32 &&
			      cipher->ivsize == 16, "CBC-AES metadata");
			*cipher_seen = found = 1;
		}
		offset += NLA_ALIGN(attribute->nla_len);
	}
	if (expected)
		CHECK(found, "algorithm-specific report present");
}

static void request(int fd, unsigned type, const char *name, int dump,
		    int malformed, int expected_error)
{
	struct {
		struct nlmsghdr header;
		struct crypto_user_alg algorithm;
	} query = {.header = {
		.nlmsg_len = NLMSG_LENGTH(sizeof(struct crypto_user_alg)),
		.nlmsg_type = type,
		.nlmsg_flags = NLM_F_REQUEST | (dump ? NLM_F_DUMP : 0),
		.nlmsg_seq = ++sequence,
		.nlmsg_pid = port,
	}};
	_Static_assert(sizeof(struct crypto_user_alg) == 208, "Linux crypto query ABI");
	if (malformed)
		memset(query.algorithm.cru_name, 'x', sizeof(query.algorithm.cru_name));
	else if (name) {
		CHECK(strlen(name) < sizeof(query.algorithm.cru_name), "query name bounds");
		strcpy(query.algorithm.cru_name, name);
	}
	struct sockaddr_nl kernel = {.nl_family = AF_NETLINK};
	struct iovec outgoing[] = {{&query.header, sizeof(query.header)},
		{&query.algorithm, sizeof(query.algorithm)}};
	struct msghdr message = {.msg_name = &kernel, .msg_namelen = sizeof(kernel),
		.msg_iov = outgoing, .msg_iovlen = 2};
	CHECK(sendmsg(fd, &message, 0) == (ssize_t)query.header.nlmsg_len, "send query vectors");
	int hash_seen = 0, cipher_seen = 0;
	unsigned reports = 0;
	for (unsigned round = 0; round < 128; round++) {
		struct pollfd ready = {.fd = fd, .events = POLLIN};
		int result;
		do { result = poll(&ready, 1, 5000); } while (result < 0 && errno == EINTR);
		CHECK(result == 1 && (ready.revents & POLLIN) &&
		      !(ready.revents & (POLLERR | POLLNVAL)), "bounded response readiness");
		struct sockaddr_nl sender = {0};
		struct iovec incoming = {response.bytes, sizeof(response.bytes)};
		struct msghdr reply = {.msg_name = &sender, .msg_namelen = sizeof(sender),
			.msg_iov = &incoming, .msg_iovlen = 1};
		ssize_t count = recvmsg(fd, &reply, 0);
		CHECK(count > 0 && count <= (ssize_t)sizeof(response.bytes) &&
		      !(reply.msg_flags & (MSG_TRUNC | MSG_CTRUNC)) &&
		      reply.msg_namelen == sizeof(sender) && sender.nl_family == AF_NETLINK &&
		      !sender.nl_pid && !sender.nl_groups, "complete kernel datagram");
		int remaining = (int)count;
		for (struct nlmsghdr *header = (void *)response.bytes;
		     NLMSG_OK(header, (unsigned)remaining); header = NLMSG_NEXT(header, remaining)) {
			CHECK(NLMSG_ALIGN(header->nlmsg_len) <= (unsigned)remaining, "message alignment bounds");
			CHECK(header->nlmsg_seq == sequence && header->nlmsg_pid == port &&
			      !(header->nlmsg_flags & NLM_F_DUMP_INTR), "reply correlation and uninterrupted dump");
			if (header->nlmsg_type == NLMSG_ERROR) {
				CHECK(header->nlmsg_len >= NLMSG_LENGTH(sizeof(struct nlmsgerr)), "error envelope");
				const struct nlmsgerr *error = NLMSG_DATA(header);
				CHECK(expected_error && error->error == -expected_error && !reports &&
				      error->msg.nlmsg_type == type && error->msg.nlmsg_seq == sequence,
				      "standard Netlink error and original request");
				return;
			}
			CHECK(!expected_error, "error request must not succeed");
			if (header->nlmsg_type == NLMSG_DONE) {
				CHECK(dump && reports && hash_seen && cipher_seen, "dump includes active algorithms");
				CHECK(header->nlmsg_len >= NLMSG_LENGTH(sizeof(int)), "dump status size");
				int status;
				memcpy(&status, NLMSG_DATA(header), sizeof(status));
				CHECK(!status, "successful multipart completion");
				return;
			}
			CHECK(header->nlmsg_type == CRYPTO_MSG_GETALG &&
			      (!dump || (header->nlmsg_flags & NLM_F_MULTI)), "algorithm response kind");
			report(header, dump ? NULL : name, &hash_seen, &cipher_seen);
			reports++;
			if (!dump)
				return;
		}
		CHECK(!remaining, "complete Netlink framing");
	}
	fail("multipart response limit");
}

int main(void)
{
	activate("hash", "sha256");
	activate("skcipher", "cbc(aes)");
	int fd = open_netlink();
	request(fd, CRYPTO_MSG_GETALG, "sha256", 0, 0, 0);
	request(fd, CRYPTO_MSG_GETALG, "cbc(aes)", 0, 0, 0);
	puts("NETLINK_CRYPTO: AF_ALG-instantiated SHA-256 and CBC-AES metadata queries pass");
	request(fd, CRYPTO_MSG_GETALG, "linux-wasm-no-such-algorithm", 0, 0, ENOENT);
	request(fd, CRYPTO_MSG_GETALG, NULL, 0, 1, EINVAL);
	request(fd, CRYPTO_MSG_GETALG, "sha256", 0, 0, 0);
	close_fd(fd);
	puts("NETLINK_CRYPTO: missing algorithm, malformed names and same-socket recovery pass");
	CHECK(!setgroups(0, NULL) && !setgid(65534) && !setuid(65534), "ordinary user credentials");
	CHECK(getuid() == 65534 && geteuid() == 65534, "credentials applied");
	fd = open_netlink();
	request(fd, CRYPTO_MSG_GETALG, "sha256", 0, 0, 0);
	request(fd, CRYPTO_MSG_GETALG, NULL, 1, 0, 0);
	request(fd, CRYPTO_MSG_UPDATEALG, "sha256", 0, 0, EPERM);
	request(fd, CRYPTO_MSG_GETALG, "cbc(aes)", 0, 0, 0);
	close_fd(fd);
	puts("NETLINK_CRYPTO: unprivileged query/dump, administration refusal and descriptor cleanup pass");
	return 0;
}
