// SPDX-License-Identifier: MIT
#include <ltdl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void require(int condition, const char *message)
{
    if (!condition) {
        const char *error = lt_dlerror();
        fprintf(stderr, "::vm-test::fail: libltdl: %s: %s\n", message,
                error ? error : "no libltdl error");
        exit(1);
    }
}

static void *symbol(lt_dlhandle handle, const char *name)
{
    (void)lt_dlerror();
    void *address = lt_dlsym(handle, name);
    const char *error = lt_dlerror();
    if (!address || error) {
        fprintf(stderr, "::vm-test::fail: libltdl: symbol=%s address=%p error=%s\n",
                name, address, error ? error : "none");
        exit(1);
    }
    return address;
}

int main(int argc, char **argv)
{
    if (argc != 2) {
        fprintf(stderr, "usage: libltdl-runtime <plugin-search-directory>\n");
        return 2;
    }
    require(!lt_dlinit(), "lt_dlinit");
    require(!lt_dladdsearchdir(argv[1]), "lt_dladdsearchdir");

    lt_dlhandle missing = lt_dlopenext("ltdl_missing_module_7f9b");
    require(missing == NULL, "missing extensionless module is rejected");
    const char *load_error = lt_dlerror();
    require(load_error && *load_error, "failed open reports an error");
    require(lt_dlerror() == NULL, "lt_dlerror returns the failure once");

    lt_dlhandle sample = lt_dlopenext("sample");
    require(sample != NULL, "lt_dlopenext finds sample through its .la file");
    const lt_dlinfo *sample_info = lt_dlgetinfo(sample);
    require(sample_info && sample_info->name && !strcmp(sample_info->name, "sample") &&
            sample_info->filename && strstr(sample_info->filename, "/modules/sample.so") &&
            sample_info->ref_count == 1,
            "the .la name selects its installed module path");
    int (*sample_value)(int) = (int (*)(int))symbol(sample, "value");
    int *sample_data = (int *)symbol(sample, "data");
    require(*sample_data == 5, "LTX writable data starts at its module value");
    *sample_data = 8;
    puts("libltdl: extensionless .la lookup and LTX function/data symbols pass");

    lt_dlhandle sample_again = lt_dlopenext("sample");
    sample_info = lt_dlgetinfo(sample);
    require(sample_again == sample && sample_info && sample_info->ref_count == 2,
            "repeated opens share one libltdl handle and increment ref_count");
    require(symbol(sample_again, "value") == (void *)sample_value &&
            symbol(sample_again, "data") == (void *)sample_data && *sample_data == 8,
            "repeated opens return the same function and writable data addresses");
    require(!lt_dlclose(sample_again) && sample_info->ref_count == 1,
            "closing one reference preserves the remaining handle");
    puts("libltdl: repeated-open references and shared data follow lt_dlinfo counts pass");

    lt_dladvise advise = NULL;
    require(!lt_dladvise_init(&advise), "lt_dladvise_init");
    require(!lt_dladvise_ext(&advise), "lt_dladvise_ext");
    require(!lt_dladvise_global(&advise), "lt_dladvise_global");
    lt_dlhandle provider = lt_dlopenadvise("provider", advise);
    require(provider != NULL, "lt_dlopenadvise loads the GLOBAL provider");
    require(!lt_dladvise_destroy(&advise), "lt_dladvise_destroy");
    const lt_dlinfo *provider_info = lt_dlgetinfo(provider);
    require(provider_info && provider_info->is_symglobal,
            "provider handle reports GLOBAL symbol visibility");
    require(sample_value(2) == 42 && *sample_data == 10 &&
            symbol(sample, "value") == (void *)sample_value,
            "GLOBAL provider binds the existing lazy call without changing the plugin function");
    puts("libltdl: GLOBAL provider binds the sample lazy function and updates its data pass");

    require(!lt_dlclose(provider), "lt_dlclose provider");
    require(!lt_dlclose(sample), "lt_dlclose sample");
    require(!lt_dlexit(), "lt_dlexit");
    puts("libltdl: one-shot errors recover and all handles close before exit pass");
    return 0;
}
