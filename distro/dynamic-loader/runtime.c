// SPDX-License-Identifier: MIT
#define _GNU_SOURCE
#ifndef __wasm__
#error "Run only in the isolated Linux/Wasm dynamic loading image"
#endif
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <link.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

int main_value = 5;
static _Thread_local int main_tls_guard = 501;
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
    if (!address || error) {
        /* dlerror consumes its state. Preserve this result instead of asking
         * require() to read it again and hiding the original loader failure. */
        fprintf(stderr, "::vm-test::fail: dynamic loader: symbol=%s address=%p errno=%d dlerror=%s\n",
                name, address, errno, error ? error : "none");
        exit(1);
    }
    return address;
}

__attribute__((noinline)) static int main_private_next_lookup(int value)
{
    int (*next)(int) = symbol(RTLD_NEXT, "next_chain");
    return next(value);
}

int main_next_lookup(int value)
{
    return main_private_next_lookup(value);
}
static void copy_path_library(const char *destination)
{
    int source = open("/plugins/path-library.so", O_RDONLY | O_CLOEXEC);
    int target = open(destination, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    require(source >= 0 && target >= 0, "byte-named library files");
    char bytes[4096];
    for (;;) {
        ssize_t count = read(source, bytes, sizeof bytes);
        if (count < 0 && errno == EINTR) continue;
        require(count >= 0, "copy library read");
        if (!count) break;
        for (ssize_t offset = 0; offset < count;) {
            ssize_t written = write(target, bytes + offset, count - offset);
            if (written < 0 && errno == EINTR) continue;
            require(written > 0, "copy library write");
            offset += written;
        }
    }
    require(!close(target) && !close(source), "copy library descriptors close");
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
    int (*vector_check)(void) = symbol(cycle, "cycle_vector_check");
    require(*(int *)symbol(cycle, "cycle_b_vector_observed") == 220 && vector_check() == 220,
            "SIMD arguments stay in Wasm during forward constructor and mutual calls");
    void *cycle_peer = dlopen("cycle-b.so", RTLD_NOW | RTLD_NOLOAD);
    require(cycle_peer != 0 && symbol(cycle_peer, "cycle_a_value") == a_value &&
            *a_count == 1 && *b_count == 1, "cyclic dependency reopen reuses instances");
    require(!dlclose(cycle) && !dlclose(cycle_peer) && descriptors() == baseline,
            "cyclic resident close and descriptor cleanup");
    puts("dynamic loader: cyclic dependencies, peer constructors and canonical relocations pass");
    puts("dynamic loader: cross-module SIMD signatures and typed forward calls pass");

    int (*a_tls_step)(int) = symbol(cycle, "cycle_a_tls_step");
    int (*b_tls_step)(int) = symbol(cycle, "cycle_b_tls_step");
    int *(*a_tls_data)(void) = symbol(cycle, "cycle_a_tls_data");
    int *(*b_tls_data)(void) = symbol(cycle, "cycle_b_tls_data");
    require(*(int *)symbol(cycle, "cycle_a_tls_observed") == 42 &&
            *(int *)symbol(cycle, "cycle_b_tls_observed") == 22,
            "peer constructors observe initialized first-thread TLS and zero tails");
    int *(*a_tls_relocated)(void) = symbol(cycle, "cycle_a_tls_relocated");
    int *(*b_tls_relocated)(void) = symbol(cycle, "cycle_b_tls_relocated");
    require(a_tls_relocated() == b_value && b_tls_relocated() == a_value,
            "TLS pointer initializers bind relocated peer data");
    require(*(int *)symbol(cycle, "cycle_a_tls_reference_observed") == 1 &&
            *(int *)symbol(cycle, "cycle_b_tls_reference_observed") == 1,
            "TLS pointer relocations precede peer constructors");
    require(a_tls_step(2) == 25 && b_tls_step(3) == 46 &&
            *a_tls_data() == 24 && *b_tls_data() == 45 && a_tls_data() != b_tls_data() &&
            main_tls_guard++ == 501, "module TLS blocks and main thread state stay independent");
    require(!dlsym(cycle, "cycle_a_tls") && dlerror(), "hidden TLS has no ordinary data binding");
    require(dlopen("cycle-a.so", RTLD_NOW | RTLD_NOLOAD) == cycle &&
            a_tls_step(1) == 27 && *a_tls_data() == 25 && main_tls_guard == 502,
            "resident lookup does not initialize TLS again");
    puts("dynamic loader: first-thread private TLS initialization, isolation and resident reuse pass");

    void *recursive = dlopen("reentrant-root.so", RTLD_NOW | RTLD_GLOBAL);
    require(recursive != 0, "constructor can open a new graph");
    void *recursive_leaf = dlopen("reentrant-leaf.so", RTLD_NOW | RTLD_NOLOAD);
    require(recursive_leaf != 0 && *(int *)symbol(recursive, "reentrant_root_errors") == 0 &&
            *(int *)symbol(recursive_leaf, "reentrant_leaf_errors") == 0,
            "recursive failure recovery, GLOBAL imports and initializing-parent reopen");
    require(*(int *)symbol(recursive, "reentrant_root_count") == 1 &&
            *(int *)symbol(recursive_leaf, "reentrant_leaf_count") == 1 &&
            *(int *)symbol(recursive, "reentrant_root_value") == 26 &&
            *(int *)symbol(recursive, "reentrant_root_observed") == 25 &&
            *(int **)symbol(recursive_leaf, "reentrant_leaf_saved") ==
                symbol(recursive, "reentrant_root_value"), "recursive canonical pointers, relocation and single constructors");
    require(dlopen("reentrant-root.so", RTLD_NOW | RTLD_NOLOAD) == recursive &&
            !dlclose(recursive) && !dlclose(recursive_leaf) && descriptors() == baseline,
            "recursive resident reuse and descriptor cleanup");
    puts("dynamic loader: constructor dlopen, nested rejection recovery and single initialization pass");

    struct link_map *head = 0;
    require(!dlinfo(self, RTLD_DI_LINKMAP, &head) && head == (struct link_map *)self &&
            !((uintptr_t)head % _Alignof(struct link_map)), "main handle is an actual link_map");
    require(!head->l_prev && !head->l_addr && head->l_name && !*head->l_name && !head->l_ld,
            "static Wasm main metadata has no ELF dynamic section");
    struct link_map *previous = 0, *entry = head;
    unsigned maps = 0, found_dependency = 0, found_root = 0;
    while (entry && maps < 16) {
        struct link_map *same = 0;
        require(entry->l_prev == previous && entry->l_name && !entry->l_ld &&
                !dlinfo(entry, RTLD_DI_LINKMAP, &same) && same == entry,
                "every mapped dependency has stable bidirectional metadata and valid handle");
        if (entry == (struct link_map *)dependency) {
            found_dependency++;
            require(!strcmp(entry->l_name, "/plugins/deps/libplugin-a.so") && entry->l_addr &&
                    (uintptr_t)data() >= entry->l_addr &&
                    (uintptr_t)data() - entry->l_addr < 64 * 1024 * 1024,
                    "dependency path and linear data base");
        }
        if (entry == (struct link_map *)plugin) {
            found_root++;
            require(!strcmp(entry->l_name, "/plugins/libplugin-b.so"), "inode alias preserves object name");
        }
        previous = entry;
        entry = entry->l_next;
        maps++;
    }
    require(!entry && maps == 7 && found_dependency == 1 && found_root == 1,
            "main, all dependencies and recursive objects appear exactly once, rejected files absent");
    require(!dlsym(dependency, "plugin_run") && dlerror(), "dependency handle excludes its consumer scope");
    struct link_map *unchanged = (void *)3;
    require(dlinfo((void *)3, RTLD_DI_LINKMAP, &unchanged) == -1 && dlerror() &&
            unchanged == (void *)3 && dlinfo(self, -777, &unchanged) == -1 && dlerror() &&
            unchanged == (void *)3, "invalid handle and unsupported request preserve output");
    require(!dlinfo(alias, RTLD_DI_LINKMAP, &unchanged) && unchanged == (struct link_map *)plugin &&
            descriptors() == baseline, "resident close and alias keep stable metadata without fd leaks");
    puts("dynamic loader: real link maps, dependency scopes and metadata error recovery pass");

    const char *byte_paths[] = {
        "/plugins/raw-\200-\355\240\200.so",
        "/plugins/\357\273\277bom.so",
        "/plugins/\344\270\255\346\226\207-\360\237\230\200.so",
    };
    for (unsigned i = 0; i < sizeof byte_paths / sizeof *byte_paths; i++) {
        copy_path_library(byte_paths[i]);
        /* A leading BOM in the user's relative filename is a real filename
         * character; it must survive before LD_LIBRARY_PATH is searched. */
        void *object = dlopen(i == 1 ? byte_paths[i] + sizeof("/plugins/") - 1 : byte_paths[i], RTLD_NOW);
        require(object != NULL, "Linux filename bytes reach actual file lookup");
        int (*value)(void) = symbol(object, "path_library_value");
        int (*instances)(void) = symbol(object, "path_library_count");
        struct link_map *metadata = NULL;
        require(value() == 42 && instances() == 1 &&
                !dlinfo(object, RTLD_DI_LINKMAP, &metadata) &&
                metadata && !strcmp(metadata->l_name, byte_paths[i]),
                "independent library constructor and exact link_map filename bytes");
        char byte_alias[64];
        int count = snprintf(byte_alias, sizeof byte_alias, "/plugins/byte-alias-%u.so", i);
        require(count > 0 && (size_t)count < sizeof byte_alias &&
                !link(byte_paths[i], byte_alias), "byte-path hardlink alias");
        void *byte_handle = dlopen(byte_alias, RTLD_NOW | RTLD_NOLOAD);
        require(byte_handle == object && instances() == 1,
                "byte-path inode alias reuse without reinitialization");
        /* Do not reuse one path alias for different inodes in a resident loader. */
        require(!dlclose(byte_handle) && !dlclose(object) && !unlink(byte_alias) && !unlink(byte_paths[i]),
                "byte-path close and filesystem cleanup");
    }
    require(descriptors() == baseline, "byte-path temporary descriptor cleanup");
    puts("dynamic loader: byte-preserving filenames, BOM search and Unicode metadata pass");

    void *next_front = dlopen("next-front.so", RTLD_NOW | RTLD_GLOBAL);
    require(next_front != NULL, "load ordered NEXT dependency chain");
    void *next_middle = dlopen("/plugins/next/next-middle.so", RTLD_NOW | RTLD_NOLOAD);
    void *next_leaf = dlopen("/plugins/next/next-leaf.so", RTLD_NOW | RTLD_NOLOAD);
    require(next_middle && next_leaf, "anchor data retains both NEXT dependencies");
    int (*front_chain)(int) = symbol(next_front, "next_chain");
    int (*middle_chain)(int) = symbol(next_middle, "next_chain");
    int (*leaf_chain)(int) = symbol(next_leaf, "next_chain");
    require(front_chain != middle_chain && middle_chain != leaf_chain &&
            front_chain == symbol(RTLD_DEFAULT, "next_chain") &&
            front_chain(5) == 116 && middle_chain(5) == 115 && leaf_chain(5) == 105,
            "NEXT lookup follows each caller and keeps canonical public pointers");
    require(*(int *)symbol(next_front, "next_front_constructor_count") == 1 &&
            *(int *)symbol(next_front, "next_front_constructor_value") == 110,
            "NEXT dependency graph is available to its constructor");
    int (*(*private_function)(void))(int) = symbol(next_front, "next_private_function");
    require(private_function()(5) == 118,
            "unexported address-taken function preserves module caller identity");
    int (*call_main)(int) = symbol(next_front, "next_call_main");
    int (*call_callback)(int, int (*)(int)) = symbol(next_front, "next_call_callback");
    int (*missing_recovers)(int) = symbol(next_front, "next_missing_recovers");
    require(main_next_lookup(5) == 116 && call_main(5) == 116 &&
            call_callback(5, main_private_next_lookup) == 116 &&
            missing_recovers(5) == 116 && front_chain(5) == 116,
            "main caller restoration and missing NEXT error recover");
    require(!dlclose(next_front) && !dlclose(next_middle) && !dlclose(next_leaf) &&
            descriptors() == baseline, "NEXT chain close and descriptor cleanup");
    puts("dynamic loader: RTLD_NEXT chains, private callers and main reentry recover pass");

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
