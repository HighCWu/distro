// SPDX-License-Identifier: MIT
#define _GNU_SOURCE

#include <dlfcn.h>
#include <link.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef int (*runtime_function) (int);
typedef runtime_function (*hidden_pointer_getter) (void);

union function_pointer
{
  void *object;
  runtime_function function;
};

union getter_pointer
{
  void *object;
  hidden_pointer_getter function;
};

__attribute__ ((visibility ("default"), noinline)) int
dladdr_runtime_main_function (int value)
{
  return value + 23;
}

__attribute__ ((visibility ("default"))) unsigned char
    dladdr_runtime_main_data[12]
    = { 0x31, 0x42, 0x53, 0x64, 0x75, 0x86,
        0x97, 0xa8, 0xb9, 0xca, 0xdb, 0xec };

static const char *
base_name (const char *path)
{
  const char *slash = strrchr (path, '/');
  return slash == NULL ? path : slash + 1;
}

static int
has_substring (const char *text, const char *part)
{
  return text != NULL && part != NULL && strstr (text, part) != NULL;
}

static int
unchanged_after_failed_dladdr (void *address)
{
  static char file_sentinel[] = "file sentinel";
  static char symbol_sentinel[] = "symbol sentinel";
  static int base_sentinel;
  static int symbol_address_sentinel;
  Dl_info info;
  info.dli_fname = file_sentinel;
  info.dli_fbase = &base_sentinel;
  info.dli_sname = symbol_sentinel;
  info.dli_saddr = &symbol_address_sentinel;

  int result = dladdr (address, &info);
  return result == 0 && info.dli_fname == file_sentinel
         && info.dli_fbase == &base_sentinel
         && info.dli_sname == symbol_sentinel
         && info.dli_saddr == &symbol_address_sentinel;
}

static int
leave_lookup_error_pending (void *scope, const char *name)
{
  (void) dlerror ();
  return dlsym (scope, name) == NULL;
}

static int
pending_error_mentions (const char *name)
{
  const char *error = dlerror ();
  return error != NULL && has_substring (error, name);
}

int
main (int argc, char **argv)
{
  const char *plugin_path = argc > 1 ? argv[1] : "/plugins/dladdr-plugin.so";
  void *handle = NULL;
  runtime_function plugin_function = NULL;
  unsigned char *plugin_data = NULL;
  const char *resident_file = NULL;
  const char *resident_symbol = NULL;
  const char *resident_map_name = NULL;
  char file_copy[512];
  char symbol_copy[128];
  char map_name_copy[512];

#define REQUIRE(condition, ...)                                                \
  do                                                                           \
    {                                                                          \
      if (!(condition))                                                        \
        {                                                                      \
          fprintf (stderr, "dladdr-runtime: ");                                \
          fprintf (stderr, __VA_ARGS__);                                       \
          fputc ('\n', stderr);                                                \
          goto failure;                                                        \
        }                                                                      \
    }                                                                          \
  while (0)

  handle = dlopen (plugin_path, RTLD_NOW | RTLD_LOCAL);
  if (handle == NULL)
    {
      const char *error = dlerror ();
      fprintf (stderr, "dladdr-runtime: dlopen(%s): %s\n", plugin_path,
               error == NULL ? "unknown error" : error);
      goto failure;
    }

  union function_pointer plugin_function_pointer;
  (void) dlerror ();
  plugin_function_pointer.object = dlsym (handle, "dladdr_plugin_function");
  const char *plugin_function_error = dlerror ();
  REQUIRE (plugin_function_pointer.object != NULL
             && plugin_function_error == NULL,
           "missing plugin function");
  plugin_function = plugin_function_pointer.function;

  (void) dlerror ();
  plugin_data = dlsym (handle, "dladdr_plugin_data");
  REQUIRE (plugin_data != NULL && dlerror () == NULL, "missing plugin data");
  REQUIRE (plugin_function (5) == 22, "plugin function returned wrong value");

  struct link_map *plugin_map = NULL;
  REQUIRE (dlinfo (handle, RTLD_DI_LINKMAP, &plugin_map) == 0
             && plugin_map != NULL,
           "dlinfo(RTLD_DI_LINKMAP) failed");

  Dl_info plugin_function_info;
  REQUIRE (dladdr (plugin_function_pointer.object, &plugin_function_info) == 1,
           "dladdr did not find plugin function");
  REQUIRE (plugin_function_info.dli_fname != NULL
             && strcmp (base_name (plugin_function_info.dli_fname),
                        base_name (plugin_path))
                    == 0,
           "plugin function has wrong owning filename");
  REQUIRE (plugin_function_info.dli_fbase == (void *) plugin_map->l_addr,
           "plugin function base differs from link_map load address");
  REQUIRE (plugin_function_info.dli_sname != NULL
             && strcmp (plugin_function_info.dli_sname,
                        "dladdr_plugin_function")
                    == 0,
           "plugin function has wrong symbol name");
  REQUIRE (plugin_function_info.dli_saddr == plugin_function_pointer.object,
           "plugin function symbol address differs from dlsym address");

  puts ("dladdr runtime: plugin function metadata pass");
  fflush (stdout);

  Dl_info plugin_data_info;
  REQUIRE (dladdr (plugin_data, &plugin_data_info) == 1,
           "dladdr did not find plugin data");
  REQUIRE (plugin_data_info.dli_fname != NULL
             && strcmp (base_name (plugin_data_info.dli_fname),
                        base_name (plugin_path))
                    == 0,
           "plugin data has wrong owning filename");
  REQUIRE (plugin_data_info.dli_fbase == (void *) plugin_map->l_addr,
           "plugin data base differs from link_map load address");
  REQUIRE (plugin_data_info.dli_sname != NULL
             && strcmp (plugin_data_info.dli_sname, "dladdr_plugin_data")
                    == 0,
           "plugin data has wrong symbol name");
  REQUIRE (plugin_data_info.dli_saddr == plugin_data,
           "plugin data symbol address differs from dlsym address");

  Dl_info plugin_interior_info;
  REQUIRE (dladdr (plugin_data + 5, &plugin_interior_info) == 1,
           "dladdr did not find interior plugin data address");
  REQUIRE (plugin_interior_info.dli_fname != NULL
             && strcmp (base_name (plugin_interior_info.dli_fname),
                        base_name (plugin_path))
                    == 0
             && plugin_interior_info.dli_fbase == (void *) plugin_map->l_addr,
           "interior plugin data has wrong owning module");

  union getter_pointer hidden_getter_pointer;
  (void) dlerror ();
  hidden_getter_pointer.object
      = dlsym (handle, "dladdr_plugin_hidden_pointer");
  REQUIRE (hidden_getter_pointer.object != NULL && dlerror () == NULL,
           "missing hidden function pointer getter");
  runtime_function hidden_function
      = hidden_getter_pointer.function ();
  REQUIRE (hidden_function != NULL && hidden_function (0x1234) == (0x1234 ^ 0x5a5a),
           "hidden plugin function call failed");
  union function_pointer hidden_function_pointer;
  hidden_function_pointer.function = hidden_function;
  Dl_info hidden_function_info;
  REQUIRE (dladdr (hidden_function_pointer.object, &hidden_function_info) == 1,
           "dladdr did not find hidden plugin function");
  REQUIRE (hidden_function_info.dli_fname != NULL
             && strcmp (base_name (hidden_function_info.dli_fname),
                        base_name (plugin_path))
                    == 0
             && hidden_function_info.dli_fbase == (void *) plugin_map->l_addr,
           "hidden function has wrong owning module");

  puts ("dladdr runtime: plugin data and hidden function ownership pass");
  fflush (stdout);

  union function_pointer main_function_pointer;
  (void) dlerror ();
  main_function_pointer.object
      = dlsym (RTLD_DEFAULT, "dladdr_runtime_main_function");
  REQUIRE (main_function_pointer.object != NULL && dlerror () == NULL,
           "main function is not visible through RTLD_DEFAULT");
  REQUIRE (main_function_pointer.function (19) == 42,
           "main function returned wrong value");

  (void) dlerror ();
  unsigned char *main_data = dlsym (RTLD_DEFAULT, "dladdr_runtime_main_data");
  REQUIRE (main_data != NULL && dlerror () == NULL && main_data[0] == 0x31
             && main_data[11] == 0xec,
           "main data is not visible through RTLD_DEFAULT");

  Dl_info main_function_info;
  REQUIRE (dladdr (main_function_pointer.object, &main_function_info) == 1,
           "dladdr did not find main function");
  REQUIRE (main_function_info.dli_fname != NULL
             && main_function_info.dli_fname[0] != '\0'
             && has_substring (main_function_info.dli_fname,
                               base_name (argv[0]))
             && main_function_info.dli_sname != NULL
             && strcmp (main_function_info.dli_sname,
                        "dladdr_runtime_main_function")
                    == 0
             && main_function_info.dli_saddr == main_function_pointer.object,
           "main function metadata is incomplete or incorrect");
#if defined(__wasm__)
  REQUIRE (main_function_info.dli_fbase == NULL,
           "main module base is not zero");
#else
  REQUIRE (main_function_info.dli_fbase != NULL,
           "native main module base is unexpectedly zero");
#endif

  Dl_info main_data_info;
  REQUIRE (dladdr (main_data, &main_data_info) == 1,
           "dladdr did not find main data");
  REQUIRE (main_data_info.dli_fname != NULL
             && has_substring (main_data_info.dli_fname, base_name (argv[0]))
             && main_data_info.dli_sname != NULL
             && strcmp (main_data_info.dli_sname, "dladdr_runtime_main_data")
                    == 0
             && main_data_info.dli_saddr == main_data,
           "main data metadata is incomplete or incorrect");
#if defined(__wasm__)
  REQUIRE (main_data_info.dli_fbase == NULL, "main data base is not zero");
#else
  REQUIRE (main_data_info.dli_fbase != NULL,
           "native main data base is unexpectedly zero");
#endif

  Dl_info main_data_interior_info;
  REQUIRE (dladdr (main_data + 5, &main_data_interior_info) == 1,
           "dladdr did not find interior main data address");
  REQUIRE (main_data_interior_info.dli_fname != NULL
             && has_substring (main_data_interior_info.dli_fname,
                               base_name (argv[0]))
             && main_data_interior_info.dli_fbase == main_data_info.dli_fbase,
           "interior main data has wrong owning module");
#if defined(__wasm__)
  REQUIRE (main_data_interior_info.dli_sname == NULL
             && main_data_interior_info.dli_saddr == NULL,
           "interior main data was assigned an inexact symbol");
#endif

  void *lookup_function = dlsym (RTLD_DEFAULT, "dlsym");
  Dl_info lookup_function_info;
  REQUIRE (lookup_function != NULL && dlerror () == NULL
             && dladdr (lookup_function, &lookup_function_info) == 1,
           "dladdr lost the defining object of dlsym");
#if defined(__wasm__)
  REQUIRE (lookup_function_info.dli_fname != NULL
             && has_substring (lookup_function_info.dli_fname, base_name (argv[0]))
             && lookup_function_info.dli_fbase == NULL,
           "dlsym caller-scope handling changed its defining object");
#endif

  puts ("dladdr runtime: main executable function and data metadata pass");
  fflush (stdout);

  const char *successful_missing = "dladdr_runtime_missing_success_probe";
  REQUIRE (leave_lookup_error_pending (RTLD_DEFAULT, successful_missing),
           "expected missing dlsym to set dlerror");
  Dl_info pending_success_info;
  REQUIRE (dladdr (plugin_function_pointer.object, &pending_success_info) == 1,
           "dladdr failed while a dlsym error was pending");
  REQUIRE (pending_error_mentions (successful_missing),
           "successful dladdr consumed the pending dlerror");

  const char *failed_missing = "dladdr_runtime_missing_failed_probe";
  REQUIRE (leave_lookup_error_pending (RTLD_DEFAULT, failed_missing),
           "expected second missing dlsym to set dlerror");
  REQUIRE (unchanged_after_failed_dladdr ((void *) (uintptr_t) UINTPTR_MAX),
           "invalid high address changed Dl_info or was reported found");
  REQUIRE (pending_error_mentions (failed_missing),
           "failed dladdr consumed the pending dlerror");
  REQUIRE (unchanged_after_failed_dladdr (NULL),
           "NULL address changed Dl_info or was reported found");

  REQUIRE (plugin_function (7) == 28 && plugin_data[0] == 0x10
             && plugin_data[15] == 0x0f,
           "plugin calls or data failed after dlerror recovery");

  resident_file = plugin_function_info.dli_fname;
  resident_symbol = plugin_function_info.dli_sname;
  resident_map_name = plugin_map->l_name;
  REQUIRE (resident_file != NULL && resident_symbol != NULL
             && resident_map_name != NULL,
           "plugin metadata strings were missing before dlclose");
  REQUIRE (snprintf (file_copy, sizeof file_copy, "%s", resident_file)
                   < (int) sizeof file_copy
             && snprintf (symbol_copy, sizeof symbol_copy, "%s", resident_symbol)
                    < (int) sizeof symbol_copy
             && snprintf (map_name_copy, sizeof map_name_copy, "%s",
                          resident_map_name)
                    < (int) sizeof map_name_copy,
           "plugin metadata string exceeded the test buffer");

  REQUIRE (dlclose (handle) == 0, "dlclose failed");
  handle = NULL;
#if defined(__wasm__)
  REQUIRE (strcmp (resident_file, file_copy) == 0
             && strcmp (resident_symbol, symbol_copy) == 0
             && strcmp (resident_map_name, map_name_copy) == 0,
           "metadata strings did not remain readable after dlclose");
#endif

  puts ("dladdr runtime: error-state recovery and resident metadata pass");
  fflush (stdout);
  return 0;

failure:
  if (handle != NULL)
    (void) dlclose (handle);
  return 1;
}
