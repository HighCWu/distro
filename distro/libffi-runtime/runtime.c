/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE

#include <ffi.h>

#include <errno.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <unistd.h>

static unsigned target_calls;
static unsigned narrow_target_calls;
static unsigned char_struct_calls;
static unsigned float_struct_calls;
static unsigned pointer_struct_calls;
static unsigned pair_struct_calls;
static unsigned mixed_struct_calls;
static unsigned mixed_vararg_calls;

struct OneChar {
  signed char value;
};

struct NestedChar {
  struct OneChar value;
};

struct OneFloat {
  float value;
};

struct OnePointer {
  void *value;
};

struct PairInt {
  int32_t left;
  int32_t right;
};

struct MixedStruct {
  int32_t left;
  double right;
};

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

static struct NestedChar nested_char_target(struct NestedChar value) {
  ++char_struct_calls;
  value.value.value = (signed char)(value.value.value + 3);
  return value;
}

static struct OneFloat float_struct_target(struct OneFloat value) {
  ++float_struct_calls;
  value.value += 0.5f;
  return value;
}

static struct OnePointer pointer_struct_target(struct OnePointer value) {
  ++pointer_struct_calls;
  return value;
}

static struct PairInt pair_struct_target(struct PairInt value) {
  ++pair_struct_calls;
  value.left += 10;
  value.right -= 4;
  return value;
}

static struct MixedStruct mixed_struct_target(struct MixedStruct value) {
  ++mixed_struct_calls;
  value.left += 5;
  value.right += 1.25;
  return value;
}

static long long mixed_varargs_target(int fixed, ...) {
  va_list args;
  va_start(args, fixed);
  int narrow = va_arg(args, int);
  void *pointer = va_arg(args, void *);
  long long wide = va_arg(args, long long);
  double real = va_arg(args, double);
  va_end(args);
  ++mixed_vararg_calls;
  return (long long)fixed + narrow + (long long)(uintptr_t)pointer + wide +
    (long long)real;
}

static int fixed_cache_target(int fixed) {
  return fixed + 1;
}

static int no_tail_varargs_target(int fixed, ...) {
  return fixed + 1;
}

static int one_fixed_varargs_target(int first, ...) {
  va_list args;
  va_start(args, first);
  int second = va_arg(args, int);
  int third = va_arg(args, int);
  va_end(args);
  return first + second + third;
}

static int two_fixed_varargs_target(int first, int second, ...) {
  va_list args;
  va_start(args, second);
  int third = va_arg(args, int);
  va_end(args);
  return first + second + third;
}

static struct PairInt pair_varargs_target(struct PairInt value, int fixed, ...) {
  va_list args;
  va_start(args, fixed);
  int tail = va_arg(args, int);
  va_end(args);
  value.left += fixed + tail;
  value.right -= tail;
  return value;
}

static int exercise_aggregate_calls(void) {
  ffi_type *one_char_elements[] = {&ffi_type_sint8, NULL};
  ffi_type one_char_type = {0, 0, FFI_TYPE_STRUCT, one_char_elements};
  ffi_type *nested_char_elements[] = {&one_char_type, NULL};
  ffi_type nested_char_type = {0, 0, FFI_TYPE_STRUCT, nested_char_elements};
  ffi_type *one_float_elements[] = {&ffi_type_float, NULL};
  ffi_type one_float_type = {0, 0, FFI_TYPE_STRUCT, one_float_elements};
  ffi_type *one_pointer_elements[] = {&ffi_type_pointer, NULL};
  ffi_type one_pointer_type = {0, 0, FFI_TYPE_STRUCT, one_pointer_elements};
  ffi_type *pair_elements[] = {&ffi_type_sint32, &ffi_type_sint32, NULL};
  ffi_type pair_type = {0, 0, FFI_TYPE_STRUCT, pair_elements};
  ffi_type *mixed_elements[] = {&ffi_type_sint32, &ffi_type_double, NULL};
  ffi_type mixed_type = {0, 0, FFI_TYPE_STRUCT, mixed_elements};

  ffi_cif cif;
  ffi_type *argument_types[] = {&nested_char_type};
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &nested_char_type, argument_types) != FFI_OK) {
    fputs("libffi runtime: nested singleton struct prep failed\n", stderr);
    return -1;
  }
  struct NestedChar char_input = {{-17}};
  struct {
    unsigned char before;
    struct NestedChar value;
    unsigned char after;
  } char_result = {0x51, {{0}}, 0xa7};
  void *values[] = {&char_input};
  ffi_call(&cif, FFI_FN(nested_char_target), &char_result.value, values);
  if (char_input.value.value != -17 || char_result.value.value.value != -14 ||
      char_result.before != 0x51 || char_result.after != 0xa7 || char_struct_calls != 1) {
    fputs("libffi runtime: nested singleton struct mismatch\n", stderr);
    return -1;
  }

  ffi_type *float_arguments[] = {&one_float_type};
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &one_float_type, float_arguments) != FFI_OK) {
    fputs("libffi runtime: float singleton struct prep failed\n", stderr);
    return -1;
  }
  struct OneFloat float_input = {1.25f};
  struct OneFloat float_result = {0};
  values[0] = &float_input;
  ffi_call(&cif, FFI_FN(float_struct_target), &float_result, values);
  if (float_input.value != 1.25f || float_result.value != 1.75f || float_struct_calls != 1) {
    fputs("libffi runtime: float singleton struct mismatch\n", stderr);
    return -1;
  }

  ffi_type *pointer_arguments[] = {&one_pointer_type};
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &one_pointer_type, pointer_arguments) != FFI_OK) {
    fputs("libffi runtime: pointer singleton struct prep failed\n", stderr);
    return -1;
  }
  int pointed = 9;
  struct OnePointer pointer_input = {&pointed};
  struct OnePointer pointer_result = {NULL};
  values[0] = &pointer_input;
  ffi_call(&cif, FFI_FN(pointer_struct_target), &pointer_result, values);
  if (pointer_input.value != &pointed || pointer_result.value != &pointed ||
      pointer_struct_calls != 1) {
    fputs("libffi runtime: pointer singleton struct mismatch\n", stderr);
    return -1;
  }

  ffi_type *pair_arguments[] = {&pair_type};
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &pair_type, pair_arguments) != FFI_OK) {
    fputs("libffi runtime: pair struct prep failed\n", stderr);
    return -1;
  }
  struct PairInt pair_input = {20, 31};
  struct PairInt pair_result = {0, 0};
  values[0] = &pair_input;
  ffi_call(&cif, FFI_FN(pair_struct_target), &pair_result, values);
  if (pair_input.left != 20 || pair_input.right != 31 || pair_result.left != 30 ||
      pair_result.right != 27 || pair_struct_calls != 1) {
    fputs("libffi runtime: by-value pair copy/result mismatch\n", stderr);
    return -1;
  }
  ffi_call(&cif, FFI_FN(pair_struct_target), NULL, values);
  if (pair_input.left != 20 || pair_input.right != 31 || pair_struct_calls != 2) {
    fputs("libffi runtime: ignored aggregate result mismatch\n", stderr);
    return -1;
  }

  ffi_type *mixed_arguments[] = {&mixed_type};
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &mixed_type, mixed_arguments) != FFI_OK) {
    fputs("libffi runtime: mixed struct prep failed\n", stderr);
    return -1;
  }
  struct MixedStruct mixed_input = {7, 2.5};
  struct MixedStruct mixed_result = {0, 0};
  values[0] = &mixed_input;
  ffi_call(&cif, FFI_FN(mixed_struct_target), &mixed_result, values);
  if (mixed_input.left != 7 || mixed_input.right != 2.5 || mixed_result.left != 12 ||
      mixed_result.right != 3.75 || mixed_struct_calls != 1) {
    fputs("libffi runtime: mixed struct alignment/copy mismatch\n", stderr);
    return -1;
  }

  ffi_type *pair_varargs[] = {&pair_type, &ffi_type_sint32, &ffi_type_sint32};
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 2, 3, &pair_type,
                       pair_varargs) != FFI_OK) {
    fputs("libffi runtime: aggregate variadic prep failed\n", stderr);
    return -1;
  }
  struct PairInt pair_vararg_input = {5, 20};
  struct PairInt pair_vararg_result = {0, 0};
  int pair_vararg_fixed = 3;
  int pair_vararg_tail = 4;
  void *pair_vararg_values[] = {
    &pair_vararg_input, &pair_vararg_fixed, &pair_vararg_tail,
  };
  ffi_call(&cif, FFI_FN(pair_varargs_target), &pair_vararg_result,
           pair_vararg_values);
  if (pair_vararg_input.left != 5 || pair_vararg_input.right != 20 ||
      pair_vararg_result.left != 12 || pair_vararg_result.right != 16) {
    fputs("libffi runtime: aggregate variadic sret/byval mismatch\n", stderr);
    return -1;
  }
  ffi_call(&cif, FFI_FN(pair_varargs_target), NULL, pair_vararg_values);
  if (pair_vararg_input.left != 5 || pair_vararg_input.right != 20) {
    fputs("libffi runtime: ignored aggregate variadic result mismatch\n", stderr);
    return -1;
  }

  return 0;
}

static int exercise_variadic_calls(void) {
  ffi_cif cif;
  ffi_type *mixed_types[] = {
    &ffi_type_sint32, &ffi_type_sint32, &ffi_type_pointer,
    &ffi_type_sint64, &ffi_type_double,
  };
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 1, 5, &ffi_type_sint64,
                       mixed_types) != FFI_OK) {
    fputs("libffi runtime: mixed variadic prep failed\n", stderr);
    return -1;
  }
  int fixed = 7;
  int narrow = -5;
  int marker = 0;
  void *pointer = &marker;
  long long wide = 1234567890123LL;
  double real = 2.75;
  void *mixed_values[] = {&fixed, &narrow, &pointer, &wide, &real};
  long long result = 0;
  ffi_call(&cif, FFI_FN(mixed_varargs_target), &result, mixed_values);
  long long expected = (long long)fixed + narrow + (long long)(uintptr_t)pointer +
    wide + (long long)real;
  if (result != expected || mixed_vararg_calls != 1) {
    fprintf(stderr,
            "libffi runtime: mixed variadic tail slot mismatch result=%lld expected=%lld calls=%u\n",
            result, expected, mixed_vararg_calls);
    return -1;
  }

  ffi_type *same_types[] = {&ffi_type_sint32};
  if (ffi_prep_cif(&cif, FFI_DEFAULT_ABI, 1, &ffi_type_sint32,
                   same_types) != FFI_OK) {
    fputs("libffi runtime: nonvariadic cache-key prep failed\n", stderr);
    return -1;
  }
  int single = 10;
  void *single_values[] = {&single};
  ffi_arg int_result = 0;
  ffi_call(&cif, FFI_FN(fixed_cache_target), &int_result, single_values);
  if ((int)int_result != 11) {
    fputs("libffi runtime: nonvariadic cache-key mismatch\n", stderr);
    return -1;
  }
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 1, 1, &ffi_type_sint32,
                       same_types) != FFI_OK) {
    fputs("libffi runtime: empty variadic prep failed\n", stderr);
    return -1;
  }
  ffi_call(&cif, FFI_FN(no_tail_varargs_target), &int_result, single_values);
  if ((int)int_result != 11) {
    fputs("libffi runtime: empty variadic tail pointer mismatch\n", stderr);
    return -1;
  }

  ffi_type *same_shape_types[] = {
    &ffi_type_sint32, &ffi_type_sint32, &ffi_type_sint32,
  };
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 1, 3, &ffi_type_sint32,
                       same_shape_types) != FFI_OK) {
    fputs("libffi runtime: one-fixed cache-key prep failed\n", stderr);
    return -1;
  }
  int first = 2;
  int second = 3;
  int third = 5;
  void *same_shape_values[] = {&first, &second, &third};
  ffi_call(&cif, FFI_FN(one_fixed_varargs_target), &int_result,
           same_shape_values);
  if ((int)int_result != 10) {
    fputs("libffi runtime: one-fixed variadic cache-key mismatch\n", stderr);
    return -1;
  }
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 2, 3, &ffi_type_sint32,
                       same_shape_types) != FFI_OK) {
    fputs("libffi runtime: two-fixed cache-key prep failed\n", stderr);
    return -1;
  }
  ffi_call(&cif, FFI_FN(two_fixed_varargs_target), &int_result,
           same_shape_values);
  if ((int)int_result != 10) {
    fputs("libffi runtime: two-fixed variadic cache-key mismatch\n", stderr);
    return -1;
  }

  char formatted[64] = {0};
  size_t formatted_size = sizeof(formatted);
  const char *format = "n=%d f=%.2f s=%s";
  int format_number = -5;
  double format_real = 2.5;
  const char *format_text = "ok";
  char *formatted_pointer = formatted;
#if __SIZEOF_POINTER__ == 8
  ffi_type *size_type = &ffi_type_uint64;
#else
  ffi_type *size_type = &ffi_type_uint32;
#endif
  ffi_type *snprintf_types[] = {
    &ffi_type_pointer, size_type, &ffi_type_pointer, &ffi_type_sint32,
    &ffi_type_double, &ffi_type_pointer,
  };
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 3, 6, &ffi_type_sint32,
                       snprintf_types) != FFI_OK) {
    fputs("libffi runtime: snprintf variadic prep failed\n", stderr);
    return -1;
  }
  void *snprintf_values[] = {
    &formatted_pointer, &formatted_size, &format, &format_number, &format_real,
    &format_text,
  };
  ffi_call(&cif, FFI_FN(snprintf), &int_result, snprintf_values);
  if ((int)int_result != 16 || strcmp(formatted, "n=-5 f=2.50 s=ok") != 0) {
    fprintf(stderr, "libffi runtime: snprintf result=%d text=%s\n", (int)int_result,
            formatted);
    return -1;
  }

  ffi_type *bad_tail[] = {&ffi_type_sint32, &ffi_type_float};
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 1, 2, &ffi_type_sint32,
                       bad_tail) != FFI_BAD_ARGTYPE) {
    fputs("libffi runtime: unpromoted float tail accepted\n", stderr);
    return -1;
  }
  ffi_type *bad_small_tail[] = {&ffi_type_sint32, &ffi_type_sint8};
  if (ffi_prep_cif_var(&cif, FFI_DEFAULT_ABI, 1, 2, &ffi_type_sint32,
                       bad_small_tail) != FFI_BAD_ARGTYPE) {
    fputs("libffi runtime: unpromoted small integer tail accepted\n", stderr);
    return -1;
  }

  return 0;
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

  if (exercise_aggregate_calls() != 0) return 1;
  if (exercise_variadic_calls() != 0) return 1;

  puts("LIBFFI_RUNTIME_MIXED_CALL_OK");
  return 0;
}
