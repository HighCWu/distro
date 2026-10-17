/* SPDX-License-Identifier: MIT */
/* Local TLS semantics only: no network, browser trust store or public server. */
#include <stdio.h>
#include <string.h>
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

static int extension(X509 *cert, int nid, const char *value)
{
    X509V3_CTX context;
    X509V3_set_ctx(&context, cert, cert, NULL, NULL, 0);
    X509_EXTENSION *ext = X509V3_EXT_conf_nid(NULL, &context, nid, value);
    if (!ext) return 0;
    int result = X509_add_ext(cert, ext, -1);
    X509_EXTENSION_free(ext);
    return result == 1;
}

static X509 *credential(EVP_PKEY *key)
{
    X509 *cert = X509_new();
    if (!cert) return NULL;
    X509_NAME *name = X509_get_subject_name(cert);
    if (X509_set_version(cert, 2) != 1 ||
        ASN1_INTEGER_set(X509_get_serialNumber(cert), 42) != 1 ||
        !X509_gmtime_adj(X509_getm_notBefore(cert), -60) ||
        !X509_gmtime_adj(X509_getm_notAfter(cert), 3600) ||
        X509_set_pubkey(cert, key) != 1 ||
        X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC,
            (const unsigned char *)"Linux Wasm TLS test", -1, -1, 0) != 1 ||
        X509_set_issuer_name(cert, name) != 1 ||
        !extension(cert, NID_basic_constraints, "critical,CA:TRUE") ||
        !extension(cert, NID_key_usage, "critical,digitalSignature,keyCertSign") ||
        !extension(cert, NID_ext_key_usage, "serverAuth") ||
        !extension(cert, NID_subject_alt_name, "DNS:localhost") ||
        X509_sign(cert, key, EVP_sha256()) <= 0) {
        X509_free(cert);
        return NULL;
    }
    return cert;
}

static int transfer(SSL *sender, SSL *receiver, const unsigned char *bytes, size_t size)
{
    unsigned char received[64];
    size_t written = 0, read = 0;
    return size <= sizeof(received) &&
        SSL_write_ex(sender, bytes, size, &written) == 1 && written == size &&
        SSL_read_ex(receiver, received, sizeof(received), &read) == 1 &&
        read == size && memcmp(received, bytes, size) == 0;
}

static int scenario(EVP_PKEY *key, X509 *cert, int trust, const char *hostname, long expected)
{
    int result = 0;
    SSL_CTX *client_context = SSL_CTX_new(TLS_client_method());
    SSL_CTX *server_context = SSL_CTX_new(TLS_server_method());
    SSL *client = NULL, *server = NULL;
    BIO *client_bio = NULL, *server_bio = NULL;
    ERR_clear_error();
    if (!client_context || !server_context) goto done;
    if (SSL_CTX_set_min_proto_version(client_context, TLS1_3_VERSION) != 1 ||
        SSL_CTX_set_max_proto_version(client_context, TLS1_3_VERSION) != 1 ||
        SSL_CTX_set_min_proto_version(server_context, TLS1_3_VERSION) != 1 ||
        SSL_CTX_set_max_proto_version(server_context, TLS1_3_VERSION) != 1 ||
        SSL_CTX_use_certificate(server_context, cert) != 1 ||
        SSL_CTX_use_PrivateKey(server_context, key) != 1 ||
        SSL_CTX_check_private_key(server_context) != 1) goto done;
    /* New contexts have empty stores: do not load host/default trust paths. */
    if (trust && X509_STORE_add_cert(SSL_CTX_get_cert_store(client_context), cert) != 1)
        goto done;
    SSL_CTX_set_verify(client_context, SSL_VERIFY_PEER, NULL);
    client = SSL_new(client_context);
    server = SSL_new(server_context);
    if (!client || !server || SSL_set1_host(client, hostname) != 1 ||
        SSL_set_tlsext_host_name(client, hostname) != 1 ||
        BIO_new_bio_pair(&client_bio, 0, &server_bio, 0) != 1) goto done;
    SSL_set_bio(client, client_bio, client_bio);
    SSL_set_bio(server, server_bio, server_bio);
    client_bio = server_bio = NULL; /* SSL now owns both endpoints. */
    SSL_set_connect_state(client);
    SSL_set_accept_state(server);
    int client_done = 0, server_done = 0;
    for (int attempt = 0; attempt < 256 && !(client_done && server_done); ++attempt) {
        if (!client_done) {
            int status = SSL_do_handshake(client);
            if (status == 1) client_done = 1;
            else {
                int error = SSL_get_error(client, status);
                if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) {
                    long verification = SSL_get_verify_result(client);
                    if (expected != X509_V_OK && error == SSL_ERROR_SSL && verification == expected) {
                        printf("TLS verification: rejected %s (%ld)\n", hostname, verification);
                        result = 1;
                    }
                    goto done;
                }
            }
        }
        if (!server_done) {
            int status = SSL_do_handshake(server);
            if (status == 1) server_done = 1;
            else {
                int error = SSL_get_error(server, status);
                if (error != SSL_ERROR_WANT_READ && error != SSL_ERROR_WANT_WRITE) goto done;
            }
        }
    }
    if (expected != X509_V_OK || !client_done || !server_done ||
        SSL_get_verify_result(client) != X509_V_OK ||
        SSL_version(client) != TLS1_3_VERSION || !SSL_get0_peer_certificate(client)) goto done;
    static const unsigned char request[] = {0, 1, 127, 128, 255, 0, 42};
    static const unsigned char response[] = {42, 0, 255, 128, 127, 1, 0};
    if (!transfer(client, server, request, sizeof(request)) ||
        !transfer(server, client, response, sizeof(response))) goto done;
    puts("TLS verification: trusted localhost TLSv1.3 binary roundtrip");
    result = 1;
done:
    if (!result) {
        fprintf(stderr, "TLS verification failure: trust=%d hostname=%s expected=%ld\n",
            trust, hostname, expected);
        ERR_print_errors_fp(stderr);
    }
    BIO_free(client_bio);
    BIO_free(server_bio);
    SSL_free(client);
    SSL_free(server);
    SSL_CTX_free(client_context);
    SSL_CTX_free(server_context);
    return result;
}

int main(void)
{
    EVP_PKEY *key = EVP_EC_gen("P-256");
    X509 *cert = key ? credential(key) : NULL;
    int success = cert &&
        scenario(key, cert, 1, "localhost", X509_V_OK) &&
        scenario(key, cert, 0, "localhost", X509_V_ERR_DEPTH_ZERO_SELF_SIGNED_CERT) &&
        scenario(key, cert, 1, "wrong.invalid", X509_V_ERR_HOSTNAME_MISMATCH);
    X509_free(cert);
    EVP_PKEY_free(key);
    if (!success) return 1;
    puts("OpenSSL: verified TLS1.3, binary I/O, untrusted certificate and wrong hostname rejection");
    return 0;
}
