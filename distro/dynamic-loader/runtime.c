// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only in the isolated Linux/Wasm dynamic loading image"
#endif
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

int main_value = 5;
int main_add(int value) { return main_value += value; }
static void require(int condition, const char *message)
{
    if (!condition) {
        const char *error = dlerror();
        fprintf(stderr, "::vm-test::fail: dynamic loader: %s errno=%d dlerror=%s\n", message, errno, error ? error : "none");
        exit(1);
    }
}
static int descriptors(void)
{
    DIR *dir = opendir("/proc/self/fd");
    require(dir != 0, "open fd directory");
    int count = 0;
    while (readdir(dir)) count++;
    require(!closedir(dir), "close fd directory");
    return count;
}
static void *symbol(void *handle, const char *name)
{
    (void)dlerror();
    void *address = dlsym(handle, name);
    const char *error = dlerror();
    require(address != 0 && !error, name);
    return address;
}
int main(void)
{
    require(!mount("proc", "/proc", "proc", 0, 0), "mount proc");
    int baseline = descriptors();
    void *self = dlopen(0, RTLD_NOW);
    require(self != 0, "dlopen main");
    int (*main_function)(int) = symbol(self, "main_add");
    require(main_function == main_add && main_function(2) == 7, "main function identity");
    require(symbol(self, "main_value") == &main_value, "absolute main data");
    require(!dlsym(self, "not_a_real_symbol") && dlerror() && !dlerror(), "one-shot standard dlerror");
    puts("dynamic loader: main symbols, canonical pointers and dlerror pass");

    require(!mkdir("/plugins/shadow", 0700), "create first search directory");
    int shadow = open("/plugins/shadow/libplugin-b.so", O_CREAT | O_EXCL | O_WRONLY, 0600);
    require(shadow >= 0 && write(shadow, "bad", 3) == 3 && !close(shadow), "create shadowed malformed library");
    require(!setenv("LD_LIBRARY_PATH", "/plugins/shadow:/plugins", 1), "ordered library search environment");
    require(!dlopen("libplugin-b.so", RTLD_NOW) && dlerror(), "opened malformed library stops path search");
    require(descriptors() == baseline, "shadow rejection descriptor cleanup");
    require(!unlink("/plugins/shadow/libplugin-b.so"), "remove malformed first candidate");
    void *plugin = dlopen("libplugin-b.so", RTLD_NOW | RTLD_LOCAL);
    require(plugin != 0, "missing first candidate permits dependency graph search");
    require(!rmdir("/plugins/shadow"), "remove first search directory");
    int (*initial)(void) = symbol(plugin, "plugin_initial");
    int (*count)(void) = symbol(plugin, "plugin_count");
    int (*run)(int) = symbol(plugin, "plugin_run");
    int *(*data)(void) = symbol(plugin, "plugin_data");
    int (*(*get_function)(void))(int) = symbol(plugin, "plugin_function");
    int (*add)(int) = symbol(plugin, "library_add");
    require(initial() == 14 && count() == 1, "dependency constructors exactly once in order");
    require(data() == symbol(plugin, "library_value") && *data() == 14, "external data relocation");
    /* The returned function uses the canonical producer table slot. */
    require(get_function() == add, "cross-library function pointer identity");
    require(run(3) == 27 && *data() == 17 && main_value == 10, "library and main direct calls share state");
    require(descriptors() == baseline, "load and search descriptor cleanup");
    require(!syscall(SYS_close_range, 3L, (long)~0U, 0L), "close-range leaves mm-owned library references intact");
    puts("dynamic loader: Linux files, RUNPATH dependencies, GOT and constructors pass");

    require(!dlsym(RTLD_DEFAULT, "plugin_run") && dlerror(), "RTLD_LOCAL scope");
    require(!link("/plugins/libplugin-b.so", "/plugins/alias.so"), "hardlink alias");
    void *alias = dlopen("/plugins/alias.so", RTLD_NOW | RTLD_NOLOAD | RTLD_GLOBAL);
    require(alias == plugin && count() == 1, "inode reuse and GLOBAL promotion");
    require(symbol(RTLD_DEFAULT, "plugin_run") == (void *)run, "global canonical address");
    void *dependency = dlopen("/plugins/deps/libplugin-a.so", RTLD_NOW);
    require(dependency != 0 && count() == 1, "existing dependency does not reinitialize");
    require(symbol(dependency, "library_value") == data(), "shared dependency identity");
    require(!dlclose(alias) && !dlclose(plugin) && !dlclose(dependency), "musl resident close semantics");
    puts("dynamic loader: aliases, local/global scope, dependency reuse and close pass");

    void *cycle = dlopen("cycle-a.so", RTLD_NOW | RTLD_LOCAL);
    require(cycle != 0, "load real cyclic NEEDED graph");
    int *a_value = symbol(cycle, "cycle_a_value");
    int *b_value = symbol(cycle, "cycle_b_value");
    int *a_count = symbol(cycle, "cycle_a_count");
    int *b_count = symbol(cycle, "cycle_b_count");
    int (*a_step)(int) = symbol(cycle, "cycle_a_step");
    int (*b_step)(int) = symbol(cycle, "cycle_b_step");
    require(*a_value == 11 && *b_value == 8 && *a_count == 1 && *b_count == 1,
            "cyclic constructor schedule executes each module once");
    require(*(int *)symbol(cycle, "cycle_a_observed") == 8 &&
            *(int *)symbol(cycle, "cycle_b_observed") == 3,
            "cycle constructors can call relocated peers");
    require(*(int **)symbol(cycle, "cycle_a_saved") == b_value &&
            *(int **)symbol(cycle, "cycle_b_saved") == a_value,
            "both cyclic data relocations precede constructors");
    require(*(int (**)(int))symbol(cycle, "cycle_a_function") == b_step &&
            *(int (**)(int))symbol(cycle, "cycle_b_function") == a_step &&
            a_step(2) == 13 && b_step(2) == 10,
            "mutual direct calls and canonical function pointer relocations");
    void *cycle_peer = dlopen("cycle-b.so", RTLD_NOW | RTLD_NOLOAD);
    require(cycle_peer != 0 && symbol(cycle_peer, "cycle_a_value") == a_value &&
            *a_count == 1 && *b_count == 1, "cyclic dependency reopen reuses instances");
    require(!dlclose(cycle) && !dlclose(cycle_peer) && descriptors() == baseline,
            "cyclic resident close and descriptor cleanup");
    puts("dynamic loader: cyclic dependencies, peer constructors and canonical relocations pass");

    require(!dlopen("missing.so", RTLD_NOW) && dlerror(), "missing library failure");
    int fd = open("/plugins/bad.so", O_CREAT | O_TRUNC | O_WRONLY, 0600);
    require(fd >= 0 && write(fd, "bad", 3) == 3 && !close(fd), "create malformed library");
    require(!dlopen("/plugins/bad.so", RTLD_NOW) && dlerror(), "malformed library failure");
    require(!dlopen("libplugin-b.so", 0) && dlerror(), "mode rejection");
    require(dlopen("libplugin-b.so", RTLD_NOW | RTLD_NOLOAD) == plugin && count() == 1, "later lookup recovery");
    errno = 0;
    require(syscall(SYS_clone, 0L, 0L, 0L, 0L, 0L, 0L) == -1 && errno == EOPNOTSUPP,
            "profile refuses creation without module publication");
    require(descriptors() == baseline && !unlink("/plugins/alias.so") && !unlink("/plugins/bad.so"), "failure cleanup");
    puts("dynamic loader: missing/malformed rejection, descriptor recovery and cleanup pass");
    puts("::vm-test::pass");
    return 0;
}
