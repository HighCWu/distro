// SPDX-License-Identifier: MIT
#include <dlfcn.h>

#ifdef DYNAMIC_MAIN_POLL_CONSUMER
extern int main_reentrant_poll_checkpoints(void);
#endif

int reentrant_root_count;
int reentrant_root_value;
int reentrant_root_observed;
int reentrant_root_errors;
int reentrant_root_step(int n) { return reentrant_root_value += n; }

__attribute__((constructor)) static void initialize(void)
{
    reentrant_root_count++;
    reentrant_root_value = 20;
#ifdef DYNAMIC_MAIN_POLL_CONSUMER
    if (main_reentrant_poll_checkpoints() != 0) {
        reentrant_root_errors = 4;
        return;
    }
#endif
    (void)dlerror();
    if (dlopen("reentrant-reject.so", RTLD_NOW) || !dlerror()) {
        reentrant_root_errors = 1;
        return;
    }
    void *leaf = dlopen("reentrant-leaf.so", RTLD_NOW | RTLD_GLOBAL);
    if (!leaf) {
        reentrant_root_errors = 2;
        return;
    }
    int (*observe)(void) = dlsym(leaf, "reentrant_leaf_observe");
    if (!observe || dlerror()) {
        reentrant_root_errors = 3;
        return;
    }
    reentrant_root_observed = observe();
    reentrant_root_value++;
}
