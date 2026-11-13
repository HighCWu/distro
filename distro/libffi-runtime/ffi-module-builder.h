/* SPDX-License-Identifier: MIT */
#ifndef LINUX_WASM_LIBFFI_MODULE_BUILDER_H
#define LINUX_WASM_LIBFFI_MODULE_BUILDER_H

#include <ffi.h>

#include <stddef.h>
#include <stdint.h>

int ffi_wasm_build_call_module(unsigned address_bits, uint64_t maximum_memory_bytes,
                               unsigned nargs, const ffi_type *return_type,
                               ffi_type *const *argument_types,
                               unsigned char **bytes_out, size_t *length_out);

#endif
