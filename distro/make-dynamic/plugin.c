// SPDX-License-Identifier: MIT
#include <gnumake.h>

#include <limits.h>
#include <stdio.h>
#include <string.h>

int plugin_is_GPL_compatible = 1;

static unsigned int setup_count;

static char *make_plugin(const char *name, unsigned int argc, char **argv)
{
  char *base_value;
  char *result;
  size_t argument_length;
  size_t base_length;
  size_t result_length;

  (void)name;
  if (argc != 1 || argv == NULL || argv[0] == NULL)
    return NULL;

  base_value = gmk_expand("$(BASE_VALUE)");
  if (base_value == NULL)
    return NULL;

  argument_length = strlen(argv[0]);
  base_length = strlen(base_value);
  if (argument_length > (size_t)UINT_MAX - 2U
      || base_length > (size_t)UINT_MAX - argument_length - 2U)
    {
      gmk_free(base_value);
      return NULL;
    }

  result_length = argument_length + base_length + 2U;
  result = gmk_alloc((unsigned int)result_length);
  if (result == NULL)
    {
      gmk_free(base_value);
      return NULL;
    }

  memcpy(result, argv[0], argument_length);
  result[argument_length] = ':';
  memcpy(result + argument_length + 1U, base_value, base_length);
  result[result_length - 1U] = '\0';
  gmk_free(base_value);
  return result;
}

static char *make_nested(const char *name, unsigned int argc, char **argv)
{
  char *expanded;
  char *result;
  size_t expanded_length;
  size_t length;

  (void)name;
  if (argc != 1 || argv == NULL || argv[0] == NULL
      || strcmp(argv[0], "nested") != 0)
    return NULL;

  expanded = gmk_expand("$(wasm_plugin nested)");
  if (expanded == NULL)
    return NULL;
  expanded_length = strlen(expanded);
  if (expanded_length >= UINT_MAX)
    {
      gmk_free(expanded);
      return NULL;
    }
  length = expanded_length + 1U;

  result = gmk_alloc((unsigned int)length);
  if (result != NULL)
    memcpy(result, expanded, length);
  gmk_free(expanded);
  return result;
}

int makeplugin_gmk_setup(const gmk_floc *floc)
{
  char definitions[128];
  int length;

  if (setup_count == UINT_MAX)
    return 0;
  setup_count++;
  length = snprintf(definitions, sizeof(definitions),
                    "PLUGIN_READY := plugin-ready\n"
                    "PLUGIN_SETUP_COUNT := %u\n",
                    setup_count);
  if (length < 0 || (size_t)length >= sizeof(definitions))
    return 0;

  gmk_eval(definitions, floc);
  gmk_add_function("wasm_plugin", make_plugin, 1, 1, GMK_FUNC_DEFAULT);
  gmk_add_function("wasm_nested", make_nested, 1, 1, GMK_FUNC_DEFAULT);
  return 1;
}
