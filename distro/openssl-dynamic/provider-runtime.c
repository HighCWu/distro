/* SPDX-License-Identifier: MIT */
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/provider.h>

#include <stdio.h>
#include <string.h>

static const unsigned char expected_md4[] = {
    0xa4, 0x48, 0x01, 0x7a, 0xaf, 0x21, 0xd8, 0x52,
    0x5f, 0xc1, 0x0a, 0xe8, 0x7a, 0xa6, 0x72, 0x9d,
};
static const unsigned char expected_sha256[] = {
    0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea,
    0x41, 0x41, 0x40, 0xde, 0x5d, 0xae, 0x22, 0x23,
    0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c,
    0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad,
};

static int
digest_matches(const char *algorithm, const char *properties,
               const unsigned char *expected, size_t expected_length)
{
  EVP_MD *method = EVP_MD_fetch(NULL, algorithm, properties);
  EVP_MD_CTX *context = NULL;
  unsigned char digest[EVP_MAX_MD_SIZE];
  unsigned int digest_length = 0;
  int matches = 0;

  if (method == NULL)
    return 0;
  context = EVP_MD_CTX_new();
  if (context != NULL && EVP_DigestInit_ex2(context, method, NULL) == 1 &&
      EVP_DigestUpdate(context, "abc", 3) == 1 &&
      EVP_DigestFinal_ex(context, digest, &digest_length) == 1 &&
      digest_length == expected_length && memcmp(digest, expected, expected_length) == 0)
    matches = 1;

  EVP_MD_CTX_free(context);
  EVP_MD_free(method);
  return matches;
}

static int
fail(const char *message)
{
  fprintf(stderr, "openssl dynamic provider failure: %s\n", message);
  ERR_print_errors_fp(stderr);
  return 1;
}

int
main(void)
{
  OSSL_PROVIDER *legacy = NULL;
  OSSL_PROVIDER *default_provider = NULL;
  int result = 1;

  ERR_clear_error();
  if (OSSL_PROVIDER_load(NULL, "linux-wasm-provider-that-does-not-exist") != NULL)
    return fail("a missing provider unexpectedly loaded");
  if (ERR_peek_error() == 0)
    return fail("a missing provider did not report an error");
  ERR_clear_error();
  if (ERR_peek_error() != 0)
    return fail("the OpenSSL error queue did not clear");

  legacy = OSSL_PROVIDER_load(NULL, "legacy");
  if (legacy == NULL) {
    fail("loading the legacy provider after a failed load");
    goto done;
  }
  default_provider = OSSL_PROVIDER_load(NULL, "default");
  if (default_provider == NULL) {
    fail("loading the default provider after a failed load");
    goto done;
  }
  if (strcmp(OSSL_PROVIDER_get0_name(legacy), "legacy") != 0 ||
      strcmp(OSSL_PROVIDER_get0_name(default_provider), "default") != 0) {
    fail("provider names did not match the requested providers");
    goto done;
  }
  if (!digest_matches("MD4", "provider=legacy", expected_md4, sizeof(expected_md4))) {
    fail("legacy MD4 did not recover after the missing-provider error");
    goto done;
  }
  if (!digest_matches("SHA256", "provider=default", expected_sha256,
                      sizeof(expected_sha256))) {
    fail("default SHA-256 failed after loading both providers");
    goto done;
  }
  result = 0;

done:
  if (default_provider != NULL && OSSL_PROVIDER_unload(default_provider) != 1) {
    fail("unloading the default provider");
    result = 1;
  }
  if (legacy != NULL && OSSL_PROVIDER_unload(legacy) != 1) {
    fail("unloading the legacy provider");
    result = 1;
  }
  if (result == 0) {
    puts("openssl dynamic: missing provider rejected and error queue cleared");
    puts("openssl dynamic: legacy/default loaded; MD4 and SHA-256 verified");
    puts("openssl dynamic: both providers unloaded");
  }
  return result;
}
