/* SPDX-License-Identifier: MIT */
#ifndef LINUX_WASM_LIBFFI_MODULE_TRANSPORT_H
#define LINUX_WASM_LIBFFI_MODULE_TRANSPORT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*ffi_wasm_call_entry)(uintptr_t function, uintptr_t result, uintptr_t values);

struct ffi_wasm_module {
  void *handle;
  ffi_wasm_call_entry entry;
};

#if defined(__GNUC__)
#define FFI_WASM_HIDDEN __attribute__((visibility("hidden")))
#else
#define FFI_WASM_HIDDEN
#endif

/* Initialize out to {0} before first use; open requires it to be empty. */
FFI_WASM_HIDDEN int ffi_wasm_module_open(const unsigned char *bytes, size_t length,
                                         struct ffi_wasm_module *out);
/* Close an opened module; the handle and entry are cleared, so this is idempotent. */
FFI_WASM_HIDDEN void ffi_wasm_module_close(struct ffi_wasm_module *module);

#undef FFI_WASM_HIDDEN

#ifdef __cplusplus
}
#endif

#endif
