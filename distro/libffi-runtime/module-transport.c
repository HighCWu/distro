/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE

#include "module-transport.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static int write_module_bytes(int fd, const unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    size_t remaining = length - offset;
    size_t chunk = remaining > (size_t)SSIZE_MAX ? (size_t)SSIZE_MAX : remaining;
    ssize_t written = write(fd, bytes + offset, chunk);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      return -errno;
    }
    if (written == 0) {
      return -EIO;
    }
    offset += (size_t)written;
  }
  return 0;
}

static int close_module_fd_once(int fd) {
  if (close(fd) == 0) {
    return 0;
  }
  return -errno;
}

static void report_loader_error(const char *operation, const char *detail) {
  if (detail != NULL && detail[0] != '\0') {
    (void)fprintf(stderr, "libffi module transport: %s: %s\n", operation, detail);
  } else {
    (void)fprintf(stderr, "libffi module transport: %s failed\n", operation);
  }
}

int ffi_wasm_module_open(const unsigned char *bytes, size_t length, struct ffi_wasm_module *out) {
  if (out == NULL) {
    return -EINVAL;
  }
  if (out->handle != NULL || out->entry != NULL) {
    return -EBUSY;
  }
  out->handle = NULL;
  out->entry = NULL;
  if (bytes == NULL || length == 0) {
    return -EINVAL;
  }

  int fd = memfd_create("libffi-wasm-call", MFD_CLOEXEC);
  if (fd < 0) {
    return -errno;
  }

  int result = write_module_bytes(fd, bytes, length);
  if (result < 0) {
    (void)close_module_fd_once(fd);
    return result;
  }

  char path[64];
  int path_length = snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
  if (path_length < 0 || (size_t)path_length >= sizeof(path)) {
    (void)close_module_fd_once(fd);
    return -EOVERFLOW;
  }

  (void)dlerror();
  void *handle = dlopen(path, RTLD_NOW | RTLD_LOCAL);
  if (handle == NULL) {
    const char *error = dlerror();
    report_loader_error("dlopen", error);
    (void)close_module_fd_once(fd);
    return -ENOEXEC;
  }

  (void)dlerror();
  void *symbol = dlsym(handle, "ffi_wasm_call");
  const char *symbol_error = dlerror();
  if (symbol == NULL || symbol_error != NULL) {
    report_loader_error("dlsym(ffi_wasm_call)", symbol_error);
    (void)dlclose(handle);
    (void)close_module_fd_once(fd);
    return -ENOEXEC;
  }

  ffi_wasm_call_entry entry = (ffi_wasm_call_entry)symbol;
  result = close_module_fd_once(fd);
  if (result < 0) {
    (void)dlclose(handle);
    return result;
  }

  out->handle = handle;
  out->entry = entry;
  return 0;
}

void ffi_wasm_module_close(struct ffi_wasm_module *module) {
  if (module == NULL) {
    return;
  }
  void *handle = module->handle;
  module->handle = NULL;
  module->entry = NULL;
  if (handle != NULL) {
    (void)dlclose(handle);
  }
}
