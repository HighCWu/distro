// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <stdint.h>

#include <gawkapi.h>

int plugin_is_GPL_compatible = 1;

static const gawk_api_t *api;
static awk_ext_id_t ext_id;
static const char *ext_version = NULL;

static awk_value_t *
wasm_ext_echo(int nargs, awk_value_t *result, struct awk_ext_func *function)
{
  awk_value_t argument;
  const char prefix[] = "value:";
  size_t prefix_length = sizeof(prefix) - 1U;
  size_t result_length;
  char *value;

  (void)function;
  make_null_string(result);
  if (nargs < 1 || !get_argument(0, AWK_STRING, &argument))
    {
      warning(ext_id, "wasm_ext_echo: expected a string argument");
      return result;
    }
  if (argument.str_value.len > SIZE_MAX - prefix_length - 1U)
    {
      warning(ext_id, "wasm_ext_echo: result is too large");
      return result;
    }

  result_length = prefix_length + argument.str_value.len;
  value = gawk_malloc(result_length + 1U);
  if (value == NULL)
    {
      warning(ext_id, "wasm_ext_echo: allocation failed");
      return result;
    }

  memcpy(value, prefix, prefix_length);
  memcpy(value + prefix_length, argument.str_value.str,
         argument.str_value.len);
  value[result_length] = '\0';
  return make_malloced_string(value, result_length, result);
}

static awk_value_t *
wasm_ext_array(int nargs, awk_value_t *result, struct awk_ext_func *function)
{
  awk_value_t array;
  awk_value_t index;
  awk_value_t value;

  (void)function;
  make_number(0.0, result);
  if (nargs < 1 || !get_argument(0, AWK_ARRAY, &array))
    {
      warning(ext_id, "wasm_ext_array: expected an array argument");
      return result;
    }

  make_const_string("extension", sizeof("extension") - 1U, &index);
  make_const_string("ready", sizeof("ready") - 1U, &value);
  if (!set_array_element(array.array_cookie, &index, &value))
    {
      warning(ext_id, "wasm_ext_array: could not set extension element");
      return result;
    }

  return make_number(1.0, result);
}

static awk_ext_func_t extension_functions[] = {
  { "wasm_ext_echo", wasm_ext_echo, 1, 1, awk_false, NULL },
  { "wasm_ext_array", wasm_ext_array, 1, 1, awk_false, NULL },
  { NULL, NULL, 0, 0, awk_false, NULL }
};

static awk_bool_t
initialize_wasmext(void)
{
  awk_value_t ready;

  if (!sym_update("WASM_EXT_READY",
                  make_const_string("ready", sizeof("ready") - 1U,
                                    &ready)))
    {
      warning(ext_id, "wasmext: could not publish WASM_EXT_READY");
      return awk_false;
    }
  return awk_true;
}

static awk_bool_t (*init_func)(void) = initialize_wasmext;

dl_load_func(extension_functions, wasmext, "")
