/* SPDX-License-Identifier: MIT */
#ifndef LINUX_WASM_LIBFFI_MODULE_BUILDER_H
#define LINUX_WASM_LIBFFI_MODULE_BUILDER_H

#include <ffi.h>

#include <stddef.h>
#include <stdint.h>

enum FfiWasmTypeKind {
  FFI_WASM_TYPE_VOID,
  FFI_WASM_TYPE_SCALAR,
  FFI_WASM_TYPE_COERCED_STRUCT,
  FFI_WASM_TYPE_INDIRECT_STRUCT,
};

typedef struct FfiWasmTypeInfo {
  size_t size;
  size_t alignment;
  unsigned char kind;
  unsigned char value_type;
  unsigned char load_opcode;
  unsigned char store_opcode;
  unsigned char alignment_exponent;
  unsigned char value_size;
  unsigned char integer_bits;
  unsigned char is_signed;
} FfiWasmTypeInfo;

int ffi_wasm_describe_type(const ffi_type *type, unsigned address_bits,
                           int allow_void, FfiWasmTypeInfo *result);

int ffi_wasm_build_call_module(unsigned address_bits, uint64_t maximum_memory_bytes,
                               unsigned nargs, unsigned nfixedargs, int is_variadic,
                               const ffi_type *return_type,
                               ffi_type *const *argument_types,
                               unsigned char **bytes_out, size_t *length_out);

#endif
