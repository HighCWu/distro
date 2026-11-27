// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <errno.h>
#include <linux/if_alg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#ifndef SOL_ALG
#define SOL_ALG 279
#endif

static void require(int ok, const char *what)
{
	if (ok) return;
	fprintf(stderr, "af-alg-runtime: %s (errno=%d: %s)\n", what, errno,
		strerror(errno));
	exit(1);
}

static int alg_open(const char *type, const char *name, const void *key,
		    socklen_t key_len, int optional)
{
	int tfm = socket(AF_ALG, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
	require(tfm >= 0, "socket(AF_ALG)");

	struct sockaddr_alg sa;
	memset(&sa, 0, sizeof(sa));
	sa.salg_family = AF_ALG;
	snprintf((char *)sa.salg_type, sizeof(sa.salg_type), "%s", type);
	snprintf((char *)sa.salg_name, sizeof(sa.salg_name), "%s", name);

	if (bind(tfm, (const struct sockaddr *)&sa, sizeof(sa)) != 0) {
		if (optional && errno == ENOENT) {
			close(tfm);
			return -1;
		}
		require(0, "bind AF_ALG");
	}
	if (key != NULL) {
		require(setsockopt(tfm, SOL_ALG, ALG_SET_KEY, key, key_len) ==
				0,
			"setsockopt ALG_SET_KEY");
	}
	return tfm;
}

static void test_sha256_and_hmac(void)
{
	static const uint8_t nist_abc[32] = {
		0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
		0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
		0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
		0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
	};

	int tfm = alg_open("hash", "sha256", NULL, 0, 0);
	int op = accept(tfm, NULL, NULL);
	require(op >= 0, "accept sha256");

	require(send(op, "a", 1, MSG_MORE) == 1, "sha256 MSG_MORE chunk 1");
	require(send(op, "bc", 2, 0) == 2, "sha256 final chunk 2");

	uint8_t digest[32];
	require(read(op, digest, sizeof(digest)) == sizeof(digest),
		"read sha256 digest");
	require(memcmp(digest, nist_abc, sizeof(digest)) == 0,
		"sha256 NIST 'abc' vector matches");
	require(close(op) == 0 && close(tfm) == 0, "close sha256");

	/* RFC 4231 Test Case 2: key="Jefe", data="what do ya want for nothing?" */
	static const uint8_t rfc4231_tc2[32] = {
		0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e,
		0x6a, 0x04, 0x24, 0x26, 0x08, 0x95, 0x75, 0xc7,
		0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83,
		0x9d, 0xec, 0x58, 0xb9, 0x64, 0xec, 0x38, 0x43,
	};
	int htfm = alg_open("hash", "hmac(sha256)", "Jefe", 4, 0);
	int hop = accept(htfm, NULL, NULL);
	require(hop >= 0, "accept hmac(sha256)");
	require(send(hop, "what do ya ", 11, MSG_MORE) == 11,
		"hmac MSG_MORE chunk 1");
	require(send(hop, "want for nothing?", 17, 0) == 17,
		"hmac final chunk 2");
	require(read(hop, digest, sizeof(digest)) == sizeof(digest),
		"read hmac(sha256) digest");
	require(memcmp(digest, rfc4231_tc2, sizeof(digest)) == 0,
		"hmac(sha256) RFC 4231 TC2 matches");
	require(close(hop) == 0 && close(htfm) == 0, "close hmac(sha256)");
}

static void run_skcipher_op(int op_fd, uint32_t op_dir, const uint8_t *iv,
			    size_t iv_len, const uint8_t *in, uint8_t *out,
			    size_t len)
{
	char cbuf[CMSG_SPACE(sizeof(uint32_t)) +
		  CMSG_SPACE(sizeof(struct af_alg_iv) + 16)];
	memset(cbuf, 0, sizeof(cbuf));

	struct iovec iov = { .iov_base = (void *)in, .iov_len = len };
	struct msghdr msg;
	memset(&msg, 0, sizeof(msg));
	msg.msg_iov = &iov;
	msg.msg_iovlen = 1;
	msg.msg_control = cbuf;
	msg.msg_controllen = CMSG_SPACE(sizeof(uint32_t)) +
			     CMSG_SPACE(sizeof(struct af_alg_iv) + iv_len);

	struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_OP;
	cmsg->cmsg_len = CMSG_LEN(sizeof(uint32_t));
	memcpy(CMSG_DATA(cmsg), &op_dir, sizeof(op_dir));

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wsign-compare"
	cmsg = CMSG_NXTHDR(&msg, cmsg);
#pragma clang diagnostic pop
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_IV;
	cmsg->cmsg_len = CMSG_LEN(sizeof(struct af_alg_iv) + iv_len);
	struct af_alg_iv *alg_iv = (struct af_alg_iv *)CMSG_DATA(cmsg);
	alg_iv->ivlen = (uint32_t)iv_len;
	memcpy(alg_iv->iv, iv, iv_len);

	require(sendmsg(op_fd, &msg, 0) == (ssize_t)len, "sendmsg skcipher");
	require(read(op_fd, out, len) == (ssize_t)len, "read skcipher");
}

static void test_cbc_aes(void)
{
	static const uint8_t key[16] = {
		0x2b, 0x7e, 0x15, 0x16, 0x28, 0xae, 0xd2, 0xa6,
		0xab, 0xf7, 0x15, 0x88, 0x09, 0xcf, 0x4f, 0x3c,
	};
	static const uint8_t iv[16] = {
		0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
		0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
	};
	uint8_t pt[32];
	uint8_t ct[32];
	uint8_t dec[32];
	for (size_t i = 0; i < sizeof(pt); i++) pt[i] = (uint8_t)(i + 0x10u);

	int tfm = alg_open("skcipher", "cbc(aes)", key, sizeof(key), 0);
	int op = accept(tfm, NULL, NULL);
	require(op >= 0, "accept cbc(aes)");

	run_skcipher_op(op, ALG_OP_ENCRYPT, iv, sizeof(iv), pt, ct, sizeof(pt));
	require(memcmp(ct, pt, sizeof(pt)) != 0, "cbc(aes) ciphertext differs");

	run_skcipher_op(op, ALG_OP_DECRYPT, iv, sizeof(iv), ct, dec,
			sizeof(ct));
	require(memcmp(dec, pt, sizeof(pt)) == 0,
		"cbc(aes) decrypted plaintext matches");

	require(close(op) == 0 && close(tfm) == 0, "close cbc(aes)");
}

static ssize_t run_aead_op(int op_fd, uint32_t op_dir, const uint8_t *iv,
			   size_t iv_len, uint32_t assoclen, const uint8_t *in,
			   size_t in_len, uint8_t *out, size_t out_len)
{
	char cbuf[CMSG_SPACE(sizeof(uint32_t)) +
		  CMSG_SPACE(sizeof(struct af_alg_iv) + 12) +
		  CMSG_SPACE(sizeof(uint32_t))];
	memset(cbuf, 0, sizeof(cbuf));

	struct iovec iov = { .iov_base = (void *)in, .iov_len = in_len };
	struct msghdr msg;
	memset(&msg, 0, sizeof(msg));
	msg.msg_iov = &iov;
	msg.msg_iovlen = 1;
	msg.msg_control = cbuf;
	msg.msg_controllen = CMSG_SPACE(sizeof(uint32_t)) +
			     CMSG_SPACE(sizeof(struct af_alg_iv) + iv_len) +
			     CMSG_SPACE(sizeof(uint32_t));

	struct cmsghdr *cmsg = CMSG_FIRSTHDR(&msg);
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_OP;
	cmsg->cmsg_len = CMSG_LEN(sizeof(uint32_t));
	memcpy(CMSG_DATA(cmsg), &op_dir, sizeof(op_dir));

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wsign-compare"
	cmsg = CMSG_NXTHDR(&msg, cmsg);
#pragma clang diagnostic pop
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_IV;
	cmsg->cmsg_len = CMSG_LEN(sizeof(struct af_alg_iv) + iv_len);
	struct af_alg_iv *alg_iv = (struct af_alg_iv *)CMSG_DATA(cmsg);
	alg_iv->ivlen = (uint32_t)iv_len;
	memcpy(alg_iv->iv, iv, iv_len);

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wsign-compare"
	cmsg = CMSG_NXTHDR(&msg, cmsg);
#pragma clang diagnostic pop
	cmsg->cmsg_level = SOL_ALG;
	cmsg->cmsg_type = ALG_SET_AEAD_ASSOCLEN;
	cmsg->cmsg_len = CMSG_LEN(sizeof(uint32_t));
	memcpy(CMSG_DATA(cmsg), &assoclen, sizeof(assoclen));

	require(sendmsg(op_fd, &msg, 0) == (ssize_t)in_len, "sendmsg aead");
	return read(op_fd, out, out_len);
}

static void test_gcm_aes(void)
{
	static const uint8_t key[16] = {
		0xfe, 0xff, 0xe9, 0x92, 0x86, 0x65, 0x73, 0x1c,
		0x6d, 0x6a, 0x8f, 0x94, 0x67, 0x30, 0x83, 0x08,
	};
	static const uint8_t iv[12] = {
		0xca, 0xfe, 0xba, 0xbe, 0xfa, 0xce,
		0xdb, 0xad, 0xde, 0xca, 0xf8, 0x88,
	};
	const uint32_t assoclen = 16;
	const size_t ptlen = 32;
	const size_t taglen = 16;

	int tfm = alg_open("aead", "gcm(aes)", key, sizeof(key), 0);
	require(setsockopt(tfm, SOL_ALG, ALG_SET_AEAD_AUTHSIZE, NULL,
			   (socklen_t)taglen) == 0,
		"setsockopt ALG_SET_AEAD_AUTHSIZE");
	int op = accept(tfm, NULL, NULL);
	require(op >= 0, "accept gcm(aes)");

	uint8_t enc_in[48];
	uint8_t enc_out[64];
	uint8_t dec_out[48];
	for (size_t i = 0; i < sizeof(enc_in); i++) {
		enc_in[i] = (uint8_t)(i * 3u + 5u);
	}

	ssize_t n = run_aead_op(op, ALG_OP_ENCRYPT, iv, sizeof(iv), assoclen,
				enc_in, sizeof(enc_in), enc_out,
				sizeof(enc_out));
	require(n == (ssize_t)sizeof(enc_out), "gcm(aes) encrypt output len");
	require(memcmp(enc_out + assoclen, enc_in + assoclen, ptlen) != 0,
		"gcm(aes) ciphertext differs");

	n = run_aead_op(op, ALG_OP_DECRYPT, iv, sizeof(iv), assoclen, enc_out,
			sizeof(enc_out), dec_out, sizeof(dec_out));
	require(n == (ssize_t)sizeof(dec_out), "gcm(aes) decrypt output len");
	require(memcmp(dec_out + assoclen, enc_in + assoclen, ptlen) == 0,
		"gcm(aes) decrypted plaintext matches");

	/* Tamper 1 byte of ciphertext and verify EBADMSG rejection. */
	enc_out[assoclen] ^= 0x01u;
	errno = 0;
	n = run_aead_op(op, ALG_OP_DECRYPT, iv, sizeof(iv), assoclen, enc_out,
			sizeof(enc_out), dec_out, sizeof(dec_out));
	require(n == -1 && errno == EBADMSG,
		"gcm(aes) tampered ciphertext rejected with EBADMSG");

	require(close(op) == 0 && close(tfm) == 0, "close gcm(aes)");
}

static void test_rng(void)
{
	int tfm = alg_open("rng", "stdrng", NULL, 0, 1);
	if (tfm < 0) return;

	int op = accept(tfm, NULL, NULL);
	require(op >= 0, "accept stdrng");
	uint8_t rnd[32] = { 0 };
	require(read(op, rnd, sizeof(rnd)) == sizeof(rnd), "read stdrng");
	int non_zero = 0;
	for (size_t i = 0; i < sizeof(rnd); i++) {
		if (rnd[i] != 0) non_zero = 1;
	}
	require(non_zero, "stdrng returned non-zero entropy");
	require(close(op) == 0 && close(tfm) == 0, "close stdrng");
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	test_sha256_and_hmac();
	test_cbc_aes();
	test_gcm_aes();
	test_rng();

	puts("af-alg runtime: sha256, hmac(sha256), cbc(aes), gcm(aes) EBADMSG and stdrng pass");
	return 0;
}
