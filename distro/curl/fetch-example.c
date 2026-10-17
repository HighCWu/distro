// SPDX-License-Identifier: MIT
// A normal application: write response bytes to stdout and return to its caller.
#include <curl/curl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>

static size_t write_body(char *data, size_t size, size_t count, void *output)
{
    if (size != 0 && count > SIZE_MAX / size)
        return 0;
    size_t bytes = size * count;
    return fwrite(data, 1, bytes, output);
}

int main(int argc, char **argv)
{
    if (argc < 2 || argc > 4) {
        fprintf(stderr, "usage: %s URL [CA-file-or-- [resolve-entry]]\n", argv[0]);
        return 2;
    }
    CURLcode code = curl_global_init(CURL_GLOBAL_DEFAULT);
    if (code != CURLE_OK)
        return (int)code;
    CURL *curl = curl_easy_init();
    if (!curl) {
        curl_global_cleanup();
        return (int)CURLE_FAILED_INIT;
    }
    struct curl_slist *resolve = NULL;
    char error[CURL_ERROR_SIZE] = {0};
    int https = strncasecmp(argv[1], "https://", 8) == 0;
#define SET(option, value) do { \
    code = curl_easy_setopt(curl, option, value); \
    if (code != CURLE_OK) goto done; \
} while (0)
    SET(CURLOPT_ERRORBUFFER, error);
    SET(CURLOPT_URL, argv[1]);
    SET(CURLOPT_PROTOCOLS_STR, "file,http,https");
    SET(CURLOPT_PROXY, "");
    SET(CURLOPT_CONNECTTIMEOUT, 5L);
    SET(CURLOPT_TIMEOUT, 10L);
    SET(CURLOPT_NOSIGNAL, 1L);
    SET(CURLOPT_WRITEFUNCTION, write_body);
    SET(CURLOPT_WRITEDATA, stdout);
    // Keep both checks on even when the caller supplies a custom trust anchor.
    SET(CURLOPT_SSL_VERIFYPEER, 1L);
    SET(CURLOPT_SSL_VERIFYHOST, 2L);
    if (argc >= 3 && strcmp(argv[2], "-") != 0)
        SET(CURLOPT_CAINFO, argv[2]);
    if (argc == 4) {
        resolve = curl_slist_append(NULL, argv[3]);
        if (!resolve) {
            code = CURLE_OUT_OF_MEMORY;
            goto done;
        }
        SET(CURLOPT_RESOLVE, resolve);
    }
    if (https) {
        SET(CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
        SET(CURLOPT_SSLVERSION, (long)(CURL_SSLVERSION_TLSv1_3 | CURL_SSLVERSION_MAX_TLSv1_3));
    }
    code = curl_easy_perform(curl);
    if (code == CURLE_OK) {
        long status = 0, verification = 0;
        code = curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
        if (code == CURLE_OK && https)
            code = curl_easy_getinfo(curl, CURLINFO_SSL_VERIFYRESULT, &verification);
        if (code == CURLE_OK && (fflush(stdout) != 0 || ferror(stdout)))
            code = CURLE_WRITE_ERROR;
        if (code == CURLE_OK)
            fprintf(stderr, "libcurl response: %ld verify: %ld\n", status, verification);
    }
done:
    if (code != CURLE_OK)
        fprintf(stderr, "libcurl error: %d %s %s\n", (int)code, curl_easy_strerror(code), error);
    curl_easy_cleanup(curl);
    curl_slist_free_all(resolve);
    curl_global_cleanup();
    return (int)code;
#undef SET
}
