/* SPDX-License-Identifier: MIT */
#include "ffi-module-builder.h"

#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>

#define WASM_PAGE_SIZE UINT64_C(65536)
#define FFI_WASM_MAX_ARGS 1000U

typedef struct ByteBuffer {
  unsigned char *bytes;
  size_t length;
  size_t capacity;
} ByteBuffer;

typedef FfiWasmTypeInfo WasmType;

static int buffer_reserve(ByteBuffer *buffer, size_t additional) {
  if (additional > SIZE_MAX - buffer->length) {
    return -EOVERFLOW;
  }
  size_t needed = buffer->length + additional;
  if (needed <= buffer->capacity) {
    return 0;
  }

  size_t capacity = buffer->capacity ? buffer->capacity : 64;
  while (capacity < needed) {
    if (capacity > SIZE_MAX / 2) {
      capacity = needed;
      break;
    }
    capacity *= 2;
  }

  unsigned char *resized = realloc(buffer->bytes, capacity);
  if (resized == NULL) {
    return -ENOMEM;
  }
  buffer->bytes = resized;
  buffer->capacity = capacity;
  return 0;
}

static int buffer_append(ByteBuffer *buffer, const void *bytes, size_t length) {
  int result = buffer_reserve(buffer, length);
  if (result < 0) {
    return result;
  }
  if (length != 0) {
    memcpy(buffer->bytes + buffer->length, bytes, length);
    buffer->length += length;
  }
  return 0;
}

static int buffer_byte(ByteBuffer *buffer, unsigned char value) {
  return buffer_append(buffer, &value, sizeof(value));
}

static int buffer_u32(ByteBuffer *buffer, uint32_t value) {
  unsigned char encoded[5];
  size_t count = 0;
  do {
    unsigned char byte = (unsigned char)(value & 0x7fU);
    value >>= 7;
    if (value != 0) {
      byte |= 0x80U;
    }
    encoded[count++] = byte;
  } while (value != 0);
  return buffer_append(buffer, encoded, count);
}

static int buffer_u64(ByteBuffer *buffer, uint64_t value) {
  unsigned char encoded[10];
  size_t count = 0;
  do {
    unsigned char byte = (unsigned char)(value & 0x7fU);
    value >>= 7;
    if (value != 0) {
      byte |= 0x80U;
    }
    encoded[count++] = byte;
  } while (value != 0);
  return buffer_append(buffer, encoded, count);
}

static int buffer_s32(ByteBuffer *buffer, int32_t value) {
  unsigned char encoded[5];
  size_t count = 0;
  int more = 1;
  while (more) {
    unsigned char byte = (unsigned char)((uint32_t)value & 0x7fU);
    int32_t next = value >> 7;
    int sign = (byte & 0x40U) != 0;
    more = !((next == 0 && !sign) || (next == -1 && sign));
    if (more) {
      byte |= 0x80U;
    }
    encoded[count++] = byte;
    value = next;
  }
  return buffer_append(buffer, encoded, count);
}

static int buffer_s64(ByteBuffer *buffer, int64_t value) {
  unsigned char encoded[10];
  size_t count = 0;
  int more = 1;
  while (more) {
    unsigned char byte = (unsigned char)((uint64_t)value & 0x7fU);
    int64_t next = value >> 7;
    int sign = (byte & 0x40U) != 0;
    more = !((next == 0 && !sign) || (next == -1 && sign));
    if (more) {
      byte |= 0x80U;
    }
    encoded[count++] = byte;
    value = next;
  }
  return buffer_append(buffer, encoded, count);
}

static int buffer_name(ByteBuffer *buffer, const char *name) {
  size_t length = strlen(name);
  if (length > UINT32_MAX) {
    return -EOVERFLOW;
  }
  int result = buffer_u32(buffer, (uint32_t)length);
  return result < 0 ? result : buffer_append(buffer, name, length);
}

static int buffer_section(ByteBuffer *module, unsigned char id, const ByteBuffer *payload) {
  if (payload->length > UINT32_MAX) {
    return -EOVERFLOW;
  }
  int result = buffer_byte(module, id);
  if (result < 0) {
    return result;
  }
  result = buffer_u32(module, (uint32_t)payload->length);
  return result < 0 ? result : buffer_append(module, payload->bytes, payload->length);
}

static int buffer_custom_section(ByteBuffer *module, const char *name,
                                 const ByteBuffer *payload) {
  ByteBuffer section = {0};
  int result = buffer_name(&section, name);
  if (result == 0) {
    result = buffer_append(&section, payload->bytes, payload->length);
  }
  if (result == 0) {
    result = buffer_section(module, 0, &section);
  }
  free(section.bytes);
  return result;
}

static int pointer_value_type(unsigned address_bits) {
  return address_bits == 64 ? 0x7e : 0x7f;
}

static int is_power_of_two(size_t value) {
  return value != 0 && (value & (value - 1)) == 0;
}

static int align_up_size(size_t value, size_t alignment, size_t *result) {
  if (!is_power_of_two(alignment) || result == NULL) {
    return -EINVAL;
  }
  size_t mask = alignment - 1;
  if (value > SIZE_MAX - mask) {
    return -EOVERFLOW;
  }
  *result = (value + mask) & ~mask;
  return 0;
}

static int describe_type_recursive(const ffi_type *type, unsigned address_bits,
                                   int allow_void, unsigned depth,
                                   FfiWasmTypeInfo *result) {
  if (type == NULL || result == NULL || depth > 128) {
    return -EINVAL;
  }
  memset(result, 0, sizeof(*result));
  result->size = type->size;
  result->alignment = type->alignment;

  if (type->type == FFI_TYPE_STRUCT) {
    if (type->elements == NULL || type->size == 0 ||
        !is_power_of_two(type->alignment)) {
      return -EINVAL;
    }

    size_t field_end = 0;
    size_t largest_field_alignment = 0;
    size_t field_count = 0;
    FfiWasmTypeInfo only_field = {0};
    for (ffi_type *const *field = type->elements; *field != NULL; ++field) {
      if (field_count == UINT32_MAX || field_count >= type->size) {
        return -EINVAL;
      }
      FfiWasmTypeInfo field_info;
      int status = describe_type_recursive(*field, address_bits, 0, depth + 1,
                                           &field_info);
      if (status < 0 || field_info.kind == FFI_WASM_TYPE_VOID) {
        return status < 0 ? status : -EINVAL;
      }
      status = align_up_size(field_end, field_info.alignment, &field_end);
      if (status < 0 || field_info.size > SIZE_MAX - field_end) {
        return status < 0 ? status : -EOVERFLOW;
      }
      field_end += field_info.size;
      if (field_info.alignment > largest_field_alignment) {
        largest_field_alignment = field_info.alignment;
      }
      if (field_count == 0) {
        only_field = field_info;
      }
      ++field_count;
    }
    if (field_count == 0 || type->alignment < largest_field_alignment) {
      return -EINVAL;
    }

    size_t expected_size;
    int status = align_up_size(field_end, type->alignment, &expected_size);
    if (status < 0 || expected_size != type->size) {
      return status < 0 ? status : -EINVAL;
    }

    result->kind = FFI_WASM_TYPE_INDIRECT_STRUCT;
    /* ffi_type does not distinguish a one-field union from a struct.  This
       coercion therefore applies only to callers using a normal struct
       descriptor; union descriptors remain outside the supported contract. */
    if (field_count == 1 &&
        (only_field.kind == FFI_WASM_TYPE_SCALAR ||
         only_field.kind == FFI_WASM_TYPE_COERCED_STRUCT) &&
        type->size == only_field.size && type->alignment == only_field.alignment) {
      result->kind = FFI_WASM_TYPE_COERCED_STRUCT;
      result->value_type = only_field.value_type;
      result->load_opcode = only_field.load_opcode;
      result->store_opcode = only_field.store_opcode;
      result->alignment_exponent = only_field.alignment_exponent;
      result->value_size = only_field.value_size;
      result->integer_bits = only_field.integer_bits;
      result->is_signed = only_field.is_signed;
    }
    return 0;
  }

  if (!is_power_of_two(type->alignment) || type->size == 0 ||
      type->alignment > type->size || (type->size % type->alignment) != 0) {
    return -EINVAL;
  }

  result->kind = FFI_WASM_TYPE_SCALAR;
  switch (type->type) {
  case FFI_TYPE_VOID:
    if (!allow_void || type->size != 1 || type->alignment != ffi_type_void.alignment) {
      return -EINVAL;
    }
    result->kind = FFI_WASM_TYPE_VOID;
    return 0;
  case FFI_TYPE_SINT8:
  case FFI_TYPE_UINT8:
    if (type->size != 1 || type->alignment != ffi_type_sint8.alignment) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = type->type == FFI_TYPE_SINT8 ? 0x2c : 0x2d;
    result->store_opcode = 0x3a;
    result->alignment_exponent = 0;
    result->value_size = 1;
    result->integer_bits = 8;
    result->is_signed = type->type == FFI_TYPE_SINT8;
    return 0;
  case FFI_TYPE_SINT16:
  case FFI_TYPE_UINT16:
    if (type->size != 2 || type->alignment != ffi_type_sint16.alignment) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = type->type == FFI_TYPE_SINT16 ? 0x2e : 0x2f;
    result->store_opcode = 0x3b;
    result->alignment_exponent = 1;
    result->value_size = 2;
    result->integer_bits = 16;
    result->is_signed = type->type == FFI_TYPE_SINT16;
    return 0;
  case FFI_TYPE_SINT32:
  case FFI_TYPE_INT:
  case FFI_TYPE_UINT32:
    if (type->size != 4 || type->alignment != ffi_type_sint32.alignment) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x28;
    result->store_opcode = 0x36;
    result->alignment_exponent = 2;
    result->value_size = 4;
    result->integer_bits = 32;
    result->is_signed = type->type != FFI_TYPE_UINT32;
    return 0;
  case FFI_TYPE_SINT64:
  case FFI_TYPE_UINT64:
    if (type->size != 8 || type->alignment != ffi_type_sint64.alignment) return -EINVAL;
    result->value_type = 0x7e;
    result->load_opcode = 0x29;
    result->store_opcode = 0x37;
    result->alignment_exponent = 3;
    result->value_size = 8;
    result->integer_bits = 64;
    result->is_signed = type->type == FFI_TYPE_SINT64;
    return 0;
  case FFI_TYPE_FLOAT:
    if (type->size != 4 || type->alignment != ffi_type_float.alignment) return -EINVAL;
    result->value_type = 0x7d;
    result->load_opcode = 0x2a;
    result->store_opcode = 0x38;
    result->alignment_exponent = 2;
    result->value_size = 4;
    return 0;
  case FFI_TYPE_DOUBLE:
    if (type->size != 8 || type->alignment != ffi_type_double.alignment) return -EINVAL;
    result->value_type = 0x7c;
    result->load_opcode = 0x2b;
    result->store_opcode = 0x39;
    result->alignment_exponent = 3;
    result->value_size = 8;
    return 0;
  case FFI_TYPE_POINTER:
    if (type->size != address_bits / 8 ||
        type->alignment != ffi_type_pointer.alignment) return -EINVAL;
    result->value_type = (unsigned char)pointer_value_type(address_bits);
    result->load_opcode = address_bits == 64 ? 0x29 : 0x28;
    result->store_opcode = address_bits == 64 ? 0x37 : 0x36;
    result->alignment_exponent = address_bits == 64 ? 3 : 2;
    result->value_size = (unsigned char)(address_bits / 8);
    return 0;
  default:
    /* Complex, long double, and unsupported scalar types use other ABI rules. */
    return -ENOTSUP;
  }
}

int ffi_wasm_describe_type(const ffi_type *type, unsigned address_bits,
                           int allow_void, FfiWasmTypeInfo *result) {
  if ((address_bits != 32 && address_bits != 64) || result == NULL) {
    return -EINVAL;
  }
  return describe_type_recursive(type, address_bits, allow_void, 0, result);
}

static int emit_pointer_local_and_offset(ByteBuffer *body, unsigned address_bits,
                                         unsigned local, uint64_t offset) {
  int result = buffer_byte(body, 0x20); /* local.get */
  if (result == 0) result = buffer_u32(body, local);
  if (result == 0) result = buffer_byte(body, address_bits == 64 ? 0x42 : 0x41);
  if (result == 0) {
    result = address_bits == 64 ? buffer_s64(body, (int64_t)offset)
                                : buffer_s32(body, (int32_t)offset);
  }
  if (result == 0) result = buffer_byte(body, address_bits == 64 ? 0x7c : 0x6a);
  return result;
}

static int emit_load(ByteBuffer *body, const WasmType *type) {
  int result = buffer_byte(body, type->load_opcode);
  if (result == 0) result = buffer_u32(body, type->alignment_exponent);
  if (result == 0) result = buffer_u32(body, 0);
  return result;
}

static int emit_integer_result_extension(ByteBuffer *body, unsigned address_bits,
                                         const WasmType *type) {
  /* ffi_call requires narrow integer results to fill the ffi_arg-sized slot. */
  if (type->integer_bits == 0 || type->integer_bits >= address_bits) {
    return 0;
  }

  int result = 0;
  if (type->integer_bits < 32) {
    if (type->is_signed) {
      result = buffer_byte(body, type->integer_bits == 8 ? 0xc0 : 0xc1);
    } else {
      result = buffer_byte(body, 0x41); /* i32.const */
      if (result == 0) {
        result = buffer_s32(body, (int32_t)((UINT32_C(1) << type->integer_bits) - 1));
      }
      if (result == 0) result = buffer_byte(body, 0x71); /* i32.and */
    }
  }

  if (result == 0 && address_bits == 64 && type->integer_bits <= 32) {
    result = buffer_byte(body, type->is_signed ? 0xac : 0xad);
  }
  return result;
}

static int emit_result_store(ByteBuffer *body, unsigned address_bits,
                             const WasmType *type, int exact_width) {
  int result = 0;
  if (!exact_width) {
    result = emit_integer_result_extension(body, address_bits, type);
    if (result < 0) return result;
  }

  if (!exact_width && type->integer_bits != 0 && type->integer_bits < address_bits) {
    result = buffer_byte(body, address_bits == 64 ? 0x37 : 0x36);
    if (result == 0) result = buffer_u32(body, address_bits == 64 ? 3 : 2);
  } else {
    result = buffer_byte(body, type->store_opcode);
    if (result == 0) result = buffer_u32(body, type->alignment_exponent);
  }
  if (result == 0) result = buffer_u32(body, 0);
  return result;
}

static int emit_type_section(ByteBuffer *module, unsigned address_bits, unsigned nargs,
                             const WasmType *return_type, const WasmType *argument_types) {
  ByteBuffer section = {0};
  unsigned has_sret = return_type->kind == FFI_WASM_TYPE_INDIRECT_STRUCT;
  unsigned call_nargs = nargs + has_sret;
  unsigned has_scalar_result = return_type->kind == FFI_WASM_TYPE_SCALAR ||
    return_type->kind == FFI_WASM_TYPE_COERCED_STRUCT;
  int result = buffer_u32(&section, 2); /* call type and exported wrapper type */
  if (result == 0) result = buffer_byte(&section, 0x60);
  if (result == 0) result = buffer_u32(&section, call_nargs);
  if (result == 0 && has_sret) {
    result = buffer_byte(&section, (unsigned char)pointer_value_type(address_bits));
  }
  for (unsigned i = 0; result == 0 && i < nargs; ++i) {
    unsigned char wasm_type = argument_types[i].kind == FFI_WASM_TYPE_INDIRECT_STRUCT
      ? (unsigned char)pointer_value_type(address_bits)
      : argument_types[i].value_type;
    result = buffer_byte(&section, wasm_type);
  }
  if (result == 0) result = buffer_u32(&section, has_scalar_result ? 1 : 0);
  if (result == 0 && has_scalar_result) {
    result = buffer_byte(&section, return_type->value_type);
  }
  if (result == 0) result = buffer_byte(&section, 0x60);
  if (result == 0) result = buffer_u32(&section, 3);
  for (unsigned i = 0; result == 0 && i < 3; ++i) {
    result = buffer_byte(&section, (unsigned char)pointer_value_type(address_bits));
  }
  if (result == 0) result = buffer_u32(&section, 0);
  if (result == 0) result = buffer_section(module, 1, &section);
  free(section.bytes);
  return result;
}

static int emit_import_section(ByteBuffer *module, unsigned address_bits,
                               uint64_t maximum_memory_bytes) {
  ByteBuffer section = {0};
  uint64_t maximum_pages = maximum_memory_bytes / WASM_PAGE_SIZE;
  int result = buffer_u32(&section, 2);
  if (result == 0) result = buffer_name(&section, "env");
  if (result == 0) result = buffer_name(&section, "memory");
  if (result == 0) result = buffer_byte(&section, 2); /* memory import */
  if (result == 0) result = buffer_byte(&section, (unsigned char)(3 | (address_bits == 64 ? 4 : 0)));
  if (result == 0) result = address_bits == 64 ? buffer_u64(&section, 1) : buffer_u32(&section, 1);
  if (result == 0) result = address_bits == 64 ? buffer_u64(&section, maximum_pages)
                                                : buffer_u32(&section, (uint32_t)maximum_pages);
  if (result == 0) result = buffer_name(&section, "env");
  if (result == 0) result = buffer_name(&section, "__indirect_function_table");
  if (result == 0) result = buffer_byte(&section, 1); /* table import */
  if (result == 0) result = buffer_byte(&section, 0x70); /* funcref */
  if (result == 0) result = buffer_byte(&section, (unsigned char)(address_bits == 64 ? 4 : 0));
  if (result == 0) result = address_bits == 64 ? buffer_u64(&section, 0) : buffer_u32(&section, 0);
  if (result == 0) result = buffer_section(module, 2, &section);
  free(section.bytes);
  return result;
}

static int emit_function_section(ByteBuffer *module) {
  ByteBuffer section = {0};
  int result = buffer_u32(&section, 1);
  if (result == 0) result = buffer_u32(&section, 1); /* wrapper type */
  if (result == 0) result = buffer_section(module, 3, &section);
  free(section.bytes);
  return result;
}

static int emit_export_section(ByteBuffer *module) {
  ByteBuffer section = {0};
  int result = buffer_u32(&section, 1);
  if (result == 0) result = buffer_name(&section, "ffi_wasm_call");
  if (result == 0) result = buffer_byte(&section, 0); /* function */
  if (result == 0) result = buffer_u32(&section, 0);
  if (result == 0) result = buffer_section(module, 7, &section);
  free(section.bytes);
  return result;
}

static int emit_code_section(ByteBuffer *module, unsigned address_bits, unsigned nargs,
                             const WasmType *return_type, const WasmType *argument_types) {
  ByteBuffer body = {0};
  ByteBuffer section = {0};
  int result = buffer_u32(&body, 0); /* no locals */

  unsigned has_sret = return_type->kind == FFI_WASM_TYPE_INDIRECT_STRUCT;
  unsigned has_scalar_result = return_type->kind == FFI_WASM_TYPE_SCALAR ||
    return_type->kind == FFI_WASM_TYPE_COERCED_STRUCT;

  /* Keep scalar result storage below the call operands for the final store. */
  if (result == 0 && has_scalar_result) {
    result = buffer_byte(&body, 0x20); /* local.get result */
    if (result == 0) result = buffer_u32(&body, 1);
  }
  if (result == 0 && has_sret) {
    result = buffer_byte(&body, 0x20); /* hidden sret pointer is the first call argument */
    if (result == 0) result = buffer_u32(&body, 1);
  }

  const uint64_t pointer_size = address_bits / 8;
  for (unsigned i = 0; result == 0 && i < nargs; ++i) {
    result = emit_pointer_local_and_offset(&body, address_bits, 2,
                                           (uint64_t)i * pointer_size);
    if (result == 0) result = emit_load(&body, &(WasmType){
      .load_opcode = address_bits == 64 ? 0x29 : 0x28,
      .alignment_exponent = address_bits == 64 ? 3 : 2,
    });
    if (result == 0 && argument_types[i].kind != FFI_WASM_TYPE_INDIRECT_STRUCT) {
      result = emit_load(&body, &argument_types[i]);
    }
  }
  if (result == 0) result = buffer_byte(&body, 0x20); /* function table index */
  if (result == 0) result = buffer_u32(&body, 0);
  if (result == 0) result = buffer_byte(&body, 0x11); /* call_indirect */
  if (result == 0) result = buffer_u32(&body, 0); /* specialized call type */
  if (result == 0) result = buffer_u32(&body, 0); /* imported table 0 */
  if (result == 0 && has_scalar_result) {
    result = emit_result_store(&body, address_bits, return_type,
                               return_type->kind == FFI_WASM_TYPE_COERCED_STRUCT);
  }
  if (result == 0) result = buffer_byte(&body, 0x0b); /* end */

  if (result == 0 && body.length > UINT32_MAX) result = -EOVERFLOW;
  if (result == 0) result = buffer_u32(&section, 1);
  if (result == 0) result = buffer_u32(&section, (uint32_t)body.length);
  if (result == 0) result = buffer_append(&section, body.bytes, body.length);
  if (result == 0) result = buffer_section(module, 10, &section);

  free(body.bytes);
  free(section.bytes);
  return result;
}

static int emit_dylink_section(ByteBuffer *module, unsigned address_bits) {
  ByteBuffer metadata = {0};
  ByteBuffer subsection = {0};
  int result = buffer_u32(&subsection, 0); /* memory size */
  if (result == 0) result = buffer_u32(&subsection, 0); /* memory alignment */
  if (result == 0) result = buffer_u32(&subsection, 0); /* table size */
  if (result == 0) result = buffer_u32(&subsection, 0); /* table alignment */
  if (result == 0) result = buffer_byte(&metadata, 1);
  if (result == 0) result = buffer_u32(&metadata, (uint32_t)subsection.length);
  if (result == 0) result = buffer_append(&metadata, subsection.bytes, subsection.length);
  subsection.length = 0;

  if (result == 0) result = buffer_u32(&subsection, 1);
  if (result == 0) result = buffer_name(&subsection, "ffi_wasm_call");
  if (result == 0) result = buffer_u32(&subsection, 0);
  if (result == 0) result = buffer_byte(&metadata, 3);
  if (result == 0) result = buffer_u32(&metadata, (uint32_t)subsection.length);
  if (result == 0) result = buffer_append(&metadata, subsection.bytes, subsection.length);
  subsection.length = 0;

  if (result == 0) result = buffer_name(&subsection, address_bits == 64 ? "wasm64" : "wasm32");
  if (result == 0) result = buffer_byte(&metadata, 6);
  if (result == 0) result = buffer_u32(&metadata, (uint32_t)subsection.length);
  if (result == 0) result = buffer_append(&metadata, subsection.bytes, subsection.length);
  if (result == 0) result = buffer_custom_section(module, "dylink.0", &metadata);
  free(subsection.bytes);
  free(metadata.bytes);
  return result;
}

int ffi_wasm_build_call_module(unsigned address_bits, uint64_t maximum_memory_bytes,
                               unsigned nargs, const ffi_type *return_type,
                               ffi_type *const *argument_types,
                               unsigned char **bytes_out, size_t *length_out) {
  if (bytes_out == NULL || length_out == NULL) {
    return -EINVAL;
  }
  *bytes_out = NULL;
  *length_out = 0;
  if ((address_bits != 32 && address_bits != 64) || nargs > FFI_WASM_MAX_ARGS ||
      (nargs != 0 && argument_types == NULL) || return_type == NULL) {
    return -EINVAL;
  }
  if (maximum_memory_bytes < WASM_PAGE_SIZE || (maximum_memory_bytes % WASM_PAGE_SIZE) != 0) {
    return -EINVAL;
  }
  uint64_t maximum_pages = maximum_memory_bytes / WASM_PAGE_SIZE;
  if (address_bits == 32 && maximum_pages > 65536) {
    return -EOVERFLOW;
  }
  if (address_bits == 32 && maximum_memory_bytes > UINT64_C(0x100000000)) {
    return -EOVERFLOW;
  }

  WasmType wasm_return = {0};
  int result = ffi_wasm_describe_type(return_type, address_bits, 1, &wasm_return);
  if (result < 0) {
    return result;
  }
  WasmType *wasm_arguments = NULL;
  if (nargs != 0) {
    wasm_arguments = calloc(nargs, sizeof(*wasm_arguments));
    if (wasm_arguments == NULL) {
      return -ENOMEM;
    }
  }
  for (unsigned i = 0; i < nargs; ++i) {
    result = ffi_wasm_describe_type(argument_types[i], address_bits, 0,
                                    &wasm_arguments[i]);
    if (result < 0) {
      free(wasm_arguments);
      return result;
    }
  }

  ByteBuffer module = {0};
  static const unsigned char header[] = {0, 0x61, 0x73, 0x6d, 1, 0, 0, 0};
  result = buffer_append(&module, header, sizeof(header));
  if (result == 0) result = emit_dylink_section(&module, address_bits);
  if (result == 0) result = emit_type_section(&module, address_bits, nargs, &wasm_return,
                                               wasm_arguments);
  if (result == 0) result = emit_import_section(&module, address_bits, maximum_memory_bytes);
  if (result == 0) result = emit_function_section(&module);
  if (result == 0) result = emit_export_section(&module);
  if (result == 0) result = emit_code_section(&module, address_bits, nargs, &wasm_return,
                                               wasm_arguments);
  free(wasm_arguments);
  if (result < 0) {
    free(module.bytes);
    return result;
  }
  *bytes_out = module.bytes;
  *length_out = module.length;
  return 0;
}
