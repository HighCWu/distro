/* SPDX-License-Identifier: MIT */
#include <ffi.h>
#include <ffi_common.h>

#include "ffi-module-builder.h"
#include "module-transport.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#ifndef FFI_WASM_MAX_MEMORY_BYTES
#error "FFI_WASM_MAX_MEMORY_BYTES must match the selected Linux-Wasm platform"
#endif

#define FFI_WASM_MAX_ARGS 1000U
#define FFI_WASM_VARARGS_FLAG 1U

typedef struct FfiWasmCallCacheEntry {
  struct FfiWasmCallCacheEntry *next;
  unsigned int abi;
  unsigned int nargs;
  unsigned char result_type;
  struct ffi_wasm_module module;
  unsigned char argument_types[];
} FfiWasmCallCacheEntry;

static atomic_flag cache_lock = ATOMIC_FLAG_INIT;
static FfiWasmCallCacheEntry *cache_head;

static void cache_lock_acquire(void) {
  while (atomic_flag_test_and_set_explicit(&cache_lock, memory_order_acquire)) {
    /* The protected sections only compare or link already-built entries. */
  }
}

static void cache_lock_release(void) {
  atomic_flag_clear_explicit(&cache_lock, memory_order_release);
}

static int cif_signature(const ffi_cif *cif, unsigned char *result_type,
                         unsigned char *argument_types) {
  if (cif == NULL || cif->rtype == NULL || result_type == NULL ||
      cif->rtype->type > UINT8_MAX ||
      (cif->nargs != 0 && (cif->arg_types == NULL || argument_types == NULL))) {
    return 0;
  }
  if (cif->nargs > FFI_WASM_MAX_ARGS) {
    return 0;
  }

  *result_type = (unsigned char)cif->rtype->type;
  for (unsigned int i = 0; i < cif->nargs; ++i) {
    if (cif->arg_types[i] == NULL || cif->arg_types[i]->type > UINT8_MAX) {
      return 0;
    }
    argument_types[i] = (unsigned char)cif->arg_types[i]->type;
  }
  return 1;
}

static int cache_key_matches(const FfiWasmCallCacheEntry *entry, unsigned int abi,
                             unsigned int nargs, unsigned char result_type,
                             const unsigned char *argument_types) {
  return entry->abi == abi && entry->nargs == nargs && entry->result_type == result_type &&
         (nargs == 0 || memcmp(entry->argument_types, argument_types, nargs) == 0);
}

static FfiWasmCallCacheEntry *cache_find_locked(unsigned int abi, unsigned int nargs,
                                                 unsigned char result_type,
                                                 const unsigned char *argument_types) {
  for (FfiWasmCallCacheEntry *entry = cache_head; entry != NULL; entry = entry->next) {
    if (cache_key_matches(entry, abi, nargs, result_type, argument_types)) {
      return entry;
    }
  }
  return NULL;
}

ffi_status FFI_HIDDEN ffi_prep_cif_machdep(ffi_cif *cif) {
  if (cif == NULL || cif->rtype == NULL || cif->abi != FFI_DEFAULT_ABI) {
    return FFI_BAD_ABI;
  }
  if (cif->rtype->type > UINT8_MAX) {
    return FFI_BAD_TYPEDEF;
  }
  if (cif->flags & FFI_WASM_VARARGS_FLAG) {
    return FFI_BAD_TYPEDEF;
  }
  if (cif->nargs > FFI_WASM_MAX_ARGS || (cif->nargs != 0 && cif->arg_types == NULL)) {
    return FFI_BAD_TYPEDEF;
  }

  unsigned char result_type = (unsigned char)cif->rtype->type;
  unsigned char argument_types[FFI_WASM_MAX_ARGS];
  for (unsigned int i = 0; i < cif->nargs; ++i) {
    if (cif->arg_types[i] == NULL || cif->arg_types[i]->type > UINT8_MAX) {
      return FFI_BAD_TYPEDEF;
    }
    argument_types[i] = (unsigned char)cif->arg_types[i]->type;
  }

  cache_lock_acquire();
  int already_prepared = cache_find_locked(cif->abi, cif->nargs, result_type,
                                            argument_types) != NULL;
  cache_lock_release();
  if (already_prepared) {
    return FFI_OK;
  }

  size_t entry_size = sizeof(FfiWasmCallCacheEntry) + cif->nargs;
  FfiWasmCallCacheEntry *candidate = calloc(1, entry_size);
  if (candidate == NULL) {
    return FFI_BAD_TYPEDEF;
  }
  candidate->abi = cif->abi;
  candidate->nargs = cif->nargs;
  candidate->result_type = result_type;
  if (cif->nargs != 0) {
    memcpy(candidate->argument_types, argument_types, cif->nargs);
  }

  unsigned char *module_bytes = NULL;
  size_t module_length = 0;
  int result = ffi_wasm_build_call_module(sizeof(void *) * 8, FFI_WASM_MAX_MEMORY_BYTES,
                                           cif->nargs, cif->rtype, cif->arg_types,
                                           &module_bytes, &module_length);
  if (result == 0) {
    result = ffi_wasm_module_open(module_bytes, module_length, &candidate->module);
  }
  free(module_bytes);
  if (result < 0) {
    ffi_wasm_module_close(&candidate->module);
    free(candidate);
    return FFI_BAD_TYPEDEF;
  }

  cache_lock_acquire();
  FfiWasmCallCacheEntry *racing_entry = cache_find_locked(
    cif->abi, cif->nargs, result_type, argument_types);
  if (racing_entry == NULL) {
    candidate->next = cache_head;
    cache_head = candidate;
    candidate = NULL;
  }
  cache_lock_release();

  if (candidate != NULL) {
    ffi_wasm_module_close(&candidate->module);
    free(candidate);
  }
  return FFI_OK;
}

ffi_status FFI_HIDDEN ffi_prep_cif_machdep_var(ffi_cif *cif, unsigned int nfixedargs,
                                               unsigned int ntotalargs) {
  (void)cif;
  (void)nfixedargs;
  (void)ntotalargs;
  return FFI_BAD_TYPEDEF;
}

void ffi_call(ffi_cif *cif, void (*function)(void), void *result, void **arguments) {
  union FfiWasmResultScratch {
    ffi_arg unsigned_arg;
    ffi_sarg signed_arg;
    uint64_t unsigned_64;
    int64_t signed_64;
    double real_64;
  } scratch;

  unsigned char result_type = 0;
  unsigned char argument_types[FFI_WASM_MAX_ARGS];
  if (!cif_signature(cif, &result_type, argument_types)) {
    abort();
  }

  cache_lock_acquire();
  FfiWasmCallCacheEntry *entry = cache_find_locked(
    cif->abi, cif->nargs, result_type, argument_types);
  ffi_wasm_call_entry invoke = entry == NULL ? NULL : entry->module.entry;
  cache_lock_release();
  if (invoke == NULL) {
    /* ffi_call requires a successfully prepared ffi_cif. */
    abort();
  }

  void *result_storage = result;
  if (result_storage == NULL && cif->rtype->type != FFI_TYPE_VOID) {
    /* Some libffi targets permit a NULL result buffer when the caller ignores it. */
    result_storage = &scratch;
  }

  invoke((uintptr_t)function, (uintptr_t)result_storage, (uintptr_t)arguments);
}
