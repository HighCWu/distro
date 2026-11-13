/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE

#include <ffi.h>

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned target_calls;
static unsigned narrow_target_calls;

static int ensure_proc_fd_path(void) {
  if (access("/proc/self/fd", F_OK) == 0) {
    return 0;
  }
  if (errno != ENOENT) {
    perror("libffi runtime: inspect /proc/self/fd");
    return -1;
  }

  /* rawInitramfsTest creates the mountpoint; tolerate EEXIST for that case. */
  if (mkdir("/proc", 0555) != 0 && errno != EEXIST) {
    perror("libffi runtime: create /proc mountpoint");
    return -1;
  }
  if (mount("proc", "/proc", "proc", 0, NULL) != 0) {
    perror("libffi runtime: mount procfs");
    return -1;
  }
  if (access("/proc/self/fd", F_OK) != 0) {
    perror("libffi runtime: verify /proc/self/fd");
    return -1;
  }
  return 0;
}

static double mixed_target(int8_t signed_byte, uint16_t unsigned_word, int32_t signed_dword,
                           uint64_t unsigned_qword, float single, double real,
                           int32_t *pointer) {
  ++target_calls;
  *pointer += 3;
  return (double)signed_byte + (double)unsigned_word + (double)signed_dword +
    (double)unsigned_qword + (double)single + real + (double)*pointer;
}

static int8_t narrow_target(void) {
  ++narrow_target_calls;
  return -7;
}

int main(void) {
  if (ensure_proc_fd_path() != 0) {
    return 1;
  }

  ffi_cif cif;
  ffi_type *argument_types[] = {
    &ffi_type_sint8,
    &ffi_type_uint16,
    &ffi_type_sint32,
    &ffi_type_uint64,
    &ffi_type_float,
    &ffi_type_double,
    &ffi_type_pointer,
  };

  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 7, &ffi_type_double, argument_types) != FFI_OK) {
    fputs("libffi runtime: ffi_prep_cif failed\n", stderr);
    return 1;
  }

  int8_t signed_byte = -7;
  uint16_t unsigned_word = 500;
  int32_t signed_dword = -9;
  uint64_t unsigned_qword = 1000000;
  float single = 1.25f;
  double real = 0.375;
  int32_t pointed_value = 11;
  int32_t *pointer = &pointed_value;
  void *values[] = {
    &signed_byte,
    &unsigned_word,
    &signed_dword,
    &unsigned_qword,
    &single,
    &real,
    &pointer,
  };
  double result = 0.0;

  ffi_call(&cif, FFI_FN(mixed_target), &result, values);
  if (target_calls != 1 || pointed_value != 14 || result != 1000499.625) {
    fprintf(stderr, "libffi runtime: result=%f pointer=%d calls=%u\n", result, pointed_value, target_calls);
    return 1;
  }

  ffi_cif narrow_cif;
  if (ffi_prep_cif(&narrow_cif, FFI_DEFAULT_ABI, 0, &ffi_type_sint8, NULL) != FFI_OK) {
    fputs("libffi runtime: narrow ffi_prep_cif failed\n", stderr);
    return 1;
  }
  ffi_sarg narrow_result = 0;
  ffi_call(&narrow_cif, FFI_FN(narrow_target), &narrow_result, NULL);
  if (narrow_result != -7 || narrow_target_calls != 1) {
    fprintf(stderr, "libffi runtime: narrow result=%ld calls=%u\n",
            (long)narrow_result, narrow_target_calls);
    return 1;
  }

  ffi_call(&narrow_cif, FFI_FN(narrow_target), NULL, NULL);
  if (narrow_target_calls != 2) {
    fprintf(stderr, "libffi runtime: ignored-result calls=%u\n", narrow_target_calls);
    return 1;
  }

  puts("LIBFFI_RUNTIME_MIXED_CALL_OK");
  return 0;
}
