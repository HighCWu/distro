/* SPDX-License-Identifier: MIT */
#include <ffi.h>
#include <ffi_common.h>

#include "ffi-module-builder.h"
#include "module-transport.h"

#include <alloca.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#ifndef FFI_WASM_MAX_MEMORY_BYTES
#error "FFI_WASM_MAX_MEMORY_BYTES must match the selected Linux-Wasm platform"
#endif

#define FFI_WASM_MAX_ARGS 1000U
#define FFI_WASM_VARARGS_FLAG 1U
#define FFI_WASM_SIGNATURE_VERSION 1U

typedef struct ByteBuffer {
  unsigned char *bytes;
  size_t length;
  size_t capacity;
} ByteBuffer;

typedef struct SignatureSink {
  ByteBuffer *buffer;
  const unsigned char *expected;
  size_t expected_length;
  size_t offset;
} SignatureSink;

typedef struct FfiWasmCallCacheEntry {
  struct FfiWasmCallCacheEntry *next;
  size_t signature_length;
  struct ffi_wasm_module module;
  unsigned char signature[];
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

static int signature_sink_write(SignatureSink *sink, const void *bytes, size_t length) {
  if (sink->buffer != NULL) {
    size_t needed;
    if (length > SIZE_MAX - sink->buffer->length) return -EOVERFLOW;
    needed = sink->buffer->length + length;
    if (needed > sink->buffer->capacity) {
      size_t capacity = sink->buffer->capacity ? sink->buffer->capacity : 64;
      while (capacity < needed) {
        if (capacity > SIZE_MAX / 2) {
          capacity = needed;
          break;
        }
        capacity *= 2;
      }
      unsigned char *resized = realloc(sink->buffer->bytes, capacity);
      if (resized == NULL) return -ENOMEM;
      sink->buffer->bytes = resized;
      sink->buffer->capacity = capacity;
    }
    if (length != 0) {
      memcpy(sink->buffer->bytes + sink->buffer->length, bytes, length);
      sink->buffer->length = needed;
    }
    return 0;
  }

  if (sink->offset > sink->expected_length ||
      length > sink->expected_length - sink->offset ||
      memcmp(sink->expected + sink->offset, bytes, length) != 0) {
    return -ENOENT;
  }
  sink->offset += length;
  return 0;
}

static int signature_sink_u32(SignatureSink *sink, uint32_t value) {
  unsigned char bytes[4] = {
    (unsigned char)value,
    (unsigned char)(value >> 8),
    (unsigned char)(value >> 16),
    (unsigned char)(value >> 24),
  };
  return signature_sink_write(sink, bytes, sizeof(bytes));
}

static int signature_sink_u64(SignatureSink *sink, uint64_t value) {
  unsigned char bytes[8];
  for (unsigned i = 0; i < sizeof(bytes); ++i) {
    bytes[i] = (unsigned char)(value >> (i * 8));
  }
  return signature_sink_write(sink, bytes, sizeof(bytes));
}

static int signature_encode_type(SignatureSink *sink, const ffi_type *type,
                                 unsigned address_bits, int allow_void,
                                 unsigned depth) {
  FfiWasmTypeInfo info;
  if (type == NULL || depth > 128) return -EINVAL;
  int result = ffi_wasm_describe_type(type, address_bits, allow_void, &info);
  if (result < 0) return result;
  result = signature_sink_u32(sink, type->type);
  if (result == 0) result = signature_sink_u64(sink, (uint64_t)type->size);
  if (result == 0) result = signature_sink_u32(sink, type->alignment);

  uint32_t field_count = 0;
  if (type->type == FFI_TYPE_STRUCT) {
    for (ffi_type *const *field = type->elements; *field != NULL; ++field) {
      if (field_count == UINT32_MAX) return -EOVERFLOW;
      ++field_count;
    }
  }
  if (result == 0) result = signature_sink_u32(sink, field_count);
  for (uint32_t i = 0; result == 0 && i < field_count; ++i) {
    result = signature_encode_type(sink, type->elements[i], address_bits, 0, depth + 1);
  }
  return result;
}

static int signature_encode_cif(SignatureSink *sink, const ffi_cif *cif) {
  if (sink == NULL || cif == NULL || cif->rtype == NULL ||
      cif->nargs > FFI_WASM_MAX_ARGS ||
      (cif->nargs != 0 && cif->arg_types == NULL)) {
    return -EINVAL;
  }
  unsigned address_bits = sizeof(void *) * 8;
  int result = signature_sink_u32(sink, FFI_WASM_SIGNATURE_VERSION);
  if (result == 0) result = signature_sink_u32(sink, cif->abi);
  if (result == 0) result = signature_sink_u32(sink, address_bits);
  if (result == 0) result = signature_sink_u32(sink, cif->nargs);
  if (result == 0) {
    result = signature_encode_type(sink, cif->rtype, address_bits, 1, 0);
  }
  for (unsigned int i = 0; result == 0 && i < cif->nargs; ++i) {
    result = signature_encode_type(sink, cif->arg_types[i], address_bits, 0, 0);
  }
  return result;
}

static int signature_matches_entry(const FfiWasmCallCacheEntry *entry,
                                   const ffi_cif *cif) {
  SignatureSink sink = {
    .buffer = NULL,
    .expected = entry->signature,
    .expected_length = entry->signature_length,
    .offset = 0,
  };
  return signature_encode_cif(&sink, cif) == 0 && sink.offset == entry->signature_length;
}

static FfiWasmCallCacheEntry *cache_find_locked(const ffi_cif *cif) {
  for (FfiWasmCallCacheEntry *entry = cache_head; entry != NULL; entry = entry->next) {
    if (signature_matches_entry(entry, cif)) return entry;
  }
  return NULL;
}

static int checked_align_up(size_t value, size_t alignment, size_t *result) {
  if (alignment == 0 || (alignment & (alignment - 1)) != 0 || result == NULL) {
    return 0;
  }
  size_t mask = alignment - 1;
  if (value > SIZE_MAX - mask) return 0;
  *result = (value + mask) & ~mask;
  return 1;
}

ffi_status FFI_HIDDEN ffi_prep_cif_machdep(ffi_cif *cif) {
  if (cif == NULL || cif->rtype == NULL || cif->abi != FFI_DEFAULT_ABI) {
    return FFI_BAD_ABI;
  }
  if (cif->flags & FFI_WASM_VARARGS_FLAG) {
    return FFI_BAD_TYPEDEF;
  }

  ByteBuffer signature = {0};
  SignatureSink sink = {.buffer = &signature};
  int result = signature_encode_cif(&sink, cif);
  if (result < 0) {
    free(signature.bytes);
    return FFI_BAD_TYPEDEF;
  }

  cache_lock_acquire();
  int already_prepared = cache_find_locked(cif) != NULL;
  cache_lock_release();
  if (already_prepared) {
    free(signature.bytes);
    return FFI_OK;
  }

  if (signature.length > SIZE_MAX - sizeof(FfiWasmCallCacheEntry)) {
    free(signature.bytes);
    return FFI_BAD_TYPEDEF;
  }
  FfiWasmCallCacheEntry *candidate = calloc(1, sizeof(*candidate) + signature.length);
  if (candidate == NULL) {
    free(signature.bytes);
    return FFI_BAD_TYPEDEF;
  }
  candidate->signature_length = signature.length;
  memcpy(candidate->signature, signature.bytes, signature.length);
  free(signature.bytes);

  unsigned char *module_bytes = NULL;
  size_t module_length = 0;
  result = ffi_wasm_build_call_module(sizeof(void *) * 8, FFI_WASM_MAX_MEMORY_BYTES,
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
  FfiWasmCallCacheEntry *racing_entry = cache_find_locked(cif);
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
  } scalar_scratch;

  if (cif == NULL || cif->rtype == NULL || cif->nargs > FFI_WASM_MAX_ARGS ||
      (cif->nargs != 0 && (cif->arg_types == NULL || arguments == NULL))) {
    abort();
  }

  unsigned address_bits = sizeof(void *) * 8;
  FfiWasmTypeInfo return_type;
  FfiWasmTypeInfo argument_types[FFI_WASM_MAX_ARGS];
  if (ffi_wasm_describe_type(cif->rtype, address_bits, 1, &return_type) < 0) abort();
  for (unsigned int i = 0; i < cif->nargs; ++i) {
    if (ffi_wasm_describe_type(cif->arg_types[i], address_bits, 0,
                               &argument_types[i]) < 0) abort();
  }

  cache_lock_acquire();
  FfiWasmCallCacheEntry *entry = cache_find_locked(cif);
  ffi_wasm_call_entry invoke = entry == NULL ? NULL : entry->module.entry;
  cache_lock_release();
  if (invoke == NULL) {
    /* ffi_call requires a successfully prepared ffi_cif. */
    abort();
  }

  int has_byval_argument = 0;
  size_t maximum_alignment = sizeof(void *);
  for (unsigned int i = 0; i < cif->nargs; ++i) {
    if (argument_types[i].kind == FFI_WASM_TYPE_INDIRECT_STRUCT) {
      has_byval_argument = 1;
      if (argument_types[i].alignment > maximum_alignment) {
        maximum_alignment = argument_types[i].alignment;
      }
    }
  }

  int needs_struct_result_scratch = result == NULL && cif->rtype->type == FFI_TYPE_STRUCT;
  void **call_arguments = arguments;
  void *result_storage = result;
  if (result_storage == NULL && cif->rtype->type != FFI_TYPE_VOID &&
      cif->rtype->type != FFI_TYPE_STRUCT) {
    /* Scalar result slots follow the existing ffi_arg-sized contract. */
    result_storage = &scalar_scratch;
  }
  if (needs_struct_result_scratch && return_type.alignment > maximum_alignment) {
    maximum_alignment = return_type.alignment;
  }
  int needs_stack_area = has_byval_argument || needs_struct_result_scratch;

  if (needs_stack_area) {
    size_t pointer_bytes;
    if (__builtin_mul_overflow((size_t)cif->nargs, sizeof(void *), &pointer_bytes)) abort();
    size_t total_bytes = pointer_bytes;
    for (unsigned int i = 0; i < cif->nargs; ++i) {
      if (argument_types[i].kind != FFI_WASM_TYPE_INDIRECT_STRUCT) continue;
      if (!checked_align_up(total_bytes, argument_types[i].alignment, &total_bytes) ||
          argument_types[i].size > SIZE_MAX - total_bytes) {
        abort();
      }
      total_bytes += argument_types[i].size;
    }
    if (needs_struct_result_scratch) {
      if (!checked_align_up(total_bytes, return_type.alignment, &total_bytes) ||
          return_type.size > SIZE_MAX - total_bytes) {
        abort();
      }
      total_bytes += return_type.size;
    }
    if (maximum_alignment - 1 > SIZE_MAX - total_bytes) abort();
    size_t allocation_size = total_bytes + maximum_alignment - 1;
    unsigned char *raw_storage = __builtin_alloca(allocation_size);
    uintptr_t raw_address = (uintptr_t)raw_storage;
    if (raw_address > UINTPTR_MAX - (maximum_alignment - 1)) abort();
    uintptr_t aligned_address = (raw_address + maximum_alignment - 1) &
      ~(uintptr_t)(maximum_alignment - 1);
    unsigned char *storage = (unsigned char *)aligned_address;
    call_arguments = (void **)storage;
    size_t offset = pointer_bytes;
    for (unsigned int i = 0; i < cif->nargs; ++i) {
      if (argument_types[i].kind == FFI_WASM_TYPE_INDIRECT_STRUCT) {
        if (!checked_align_up(offset, argument_types[i].alignment, &offset) ||
            argument_types[i].size > SIZE_MAX - offset) {
          abort();
        }
        void *copy = storage + offset;
        memcpy(copy, arguments[i], argument_types[i].size);
        call_arguments[i] = copy;
        offset += argument_types[i].size;
      } else {
        call_arguments[i] = arguments[i];
      }
    }
    if (needs_struct_result_scratch) {
      if (!checked_align_up(offset, return_type.alignment, &offset)) abort();
      result_storage = storage + offset;
    }
  }

  invoke((uintptr_t)function, (uintptr_t)result_storage, (uintptr_t)call_arguments);
}
