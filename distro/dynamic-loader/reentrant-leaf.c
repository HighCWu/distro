// SPDX-License-Identifier: MIT
#include <dlfcn.h>

extern int reentrant_root_value;
extern int reentrant_root_step(int);
int reentrant_leaf_count;
int reentrant_leaf_errors;
int reentrant_leaf_observed;
int *reentrant_leaf_saved = &reentrant_root_value;
int reentrant_leaf_observe(void) { return reentrant_leaf_observed; }

__attribute__((constructor)) static void initialize(void)
{
    reentrant_leaf_count++;
    if (reentrant_root_step(2) != 22) {
        reentrant_leaf_errors = 1;
        return;
    }
    void *root = dlopen("reentrant-root.so", RTLD_NOW | RTLD_NOLOAD);
    int (*step)(int) = root ? dlsym(root, "reentrant_root_step") : 0;
    if (!step || dlerror() || step != reentrant_root_step || step(3) != 25) {
        reentrant_leaf_errors = 2;
        return;
    }
    reentrant_leaf_observed = *reentrant_leaf_saved;
}
