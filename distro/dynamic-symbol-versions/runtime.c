// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/mount.h>

static void require(int ok, const char *what)
{
    if (ok) return;
    const char *error = dlerror();
    fprintf(stderr, "::vm-test::fail: dynamic versions: %s dlerror=%s\n",
            what, error ? error : "none");
    exit(1);
}

static void *symbol(void *handle, const char *name)
{
    (void)dlerror();
    void *value = dlsym(handle, name);
    require(value != NULL, name);
    return value;
}

static int descriptors(void)
{
    DIR *directory = opendir("/proc/self/fd");
    require(directory != NULL, "descriptor directory");
    int count = 0;
    while (readdir(directory)) count++;
    require(!closedir(directory), "close descriptor directory");
    return count;
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    require(!mount("proc", "/proc", "proc", 0, NULL), "mount proc");
    int baseline = descriptors();
    require(!dlopen("/versions/missing.so", RTLD_NOW | RTLD_LOCAL) && dlerror() && !dlerror(),
            "unknown explicit version must not bind the default");
    require(!dlsym(RTLD_DEFAULT, "api") && dlerror() && descriptors() == baseline,
            "rejected graph is unpublished and releases descriptors");
    puts("dynamic versions: missing version rejection and descriptor recovery pass");

    void *consumer = dlopen("/versions/consumer.so", RTLD_NOW | RTLD_LOCAL);
    require(consumer != NULL, "load consumer and versioned provider");
    int (*checks)(long) = symbol(consumer, "version_checks");
    long input = 5;
#if LONG_MAX > 2147483647L
    input += 1L << 40;
#endif
    int result = checks(input);
    if (result) fprintf(stderr, "dynamic versions: C observation failed at check %d\n", result);
    require(result == 0 && descriptors() == baseline, "old/default calls and canonical relocations");
    puts("dynamic versions: cross-library old/default signatures, data and pointer relocations pass");

    void *provider = dlopen("/versions/provider.so", RTLD_NOW | RTLD_NOLOAD);
    require(provider != NULL, "dependency handle reuse");
    int (*(*old_pointer)(void))(int) = symbol(consumer, "version_old_pointer");
    long (*(*default_pointer)(void))(long) = symbol(consumer, "version_default_pointer");
    int *(*old_data)(void) = symbol(consumer, "version_old_data");
    int *(*current_data)(void) = symbol(consumer, "version_default_data");
    long (*current)(long) = symbol(provider, "api");
    require(default_pointer() == current && current(input) == input + 200 && old_pointer()(7) == 18,
            "dlsym selects the same default definition as C references");
    require(current_data() == symbol(provider, "setting") && *current_data() == 23 &&
            old_data() != current_data() && *old_data() == 41,
            "versioned mutation stays isolated after provider reopen");
    require(!dlsym(RTLD_DEFAULT, "api") && dlerror() &&
            !dlclose(provider) && !dlclose(consumer) && descriptors() == baseline,
            "local scope and descriptor cleanup");
    puts("dynamic versions: canonical default lookup, resident reuse and namespace isolation pass");
    puts("::vm-test::pass");
    return 0;
}
