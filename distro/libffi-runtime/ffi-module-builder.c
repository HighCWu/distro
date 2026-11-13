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

typedef struct WasmType {
  unsigned char value_type;
  unsigned char load_opcode;
  unsigned char store_opcode;
  unsigned char alignment;
  unsigned char value_size;
  unsigned char integer_bits;
  unsigned char is_signed;
} WasmType;

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

static int get_wasm_type(const ffi_type *type, unsigned address_bits, int allow_void,
                         WasmType *result) {
  if (type == NULL || result == NULL) {
    return -EINVAL;
  }

  result->alignment = 0;
  result->integer_bits = 0;
  result->is_signed = 0;
  switch (type->type) {
  case FFI_TYPE_VOID:
    /* libffi gives its sentinel ffi_type_void a nonzero placeholder size. */
    if (!allow_void || type->size != 1) {
      return -EINVAL;
    }
    result->value_type = 0;
    result->load_opcode = 0;
    result->store_opcode = 0;
    result->value_size = 0;
    return 0;
  case FFI_TYPE_SINT8:
    if (type->size != 1) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x2c; /* i32.load8_s */
    result->store_opcode = 0x3a; /* i32.store8 */
    result->alignment = 0;
    result->value_size = 1;
    result->integer_bits = 8;
    result->is_signed = 1;
    return 0;
  case FFI_TYPE_UINT8:
    if (type->size != 1) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x2d; /* i32.load8_u */
    result->store_opcode = 0x3a;
    result->alignment = 0;
    result->value_size = 1;
    result->integer_bits = 8;
    return 0;
  case FFI_TYPE_SINT16:
    if (type->size != 2) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x2e; /* i32.load16_s */
    result->store_opcode = 0x3b; /* i32.store16 */
    result->alignment = 1;
    result->value_size = 2;
    result->integer_bits = 16;
    result->is_signed = 1;
    return 0;
  case FFI_TYPE_UINT16:
    if (type->size != 2) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x2f; /* i32.load16_u */
    result->store_opcode = 0x3b;
    result->alignment = 1;
    result->value_size = 2;
    result->integer_bits = 16;
    return 0;
  case FFI_TYPE_SINT32:
  case FFI_TYPE_INT:
    if (type->size != 4) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x28; /* i32.load */
    result->store_opcode = 0x36; /* i32.store */
    result->alignment = 2;
    result->value_size = 4;
    result->integer_bits = 32;
    result->is_signed = 1;
    return 0;
  case FFI_TYPE_UINT32:
    if (type->size != 4) return -EINVAL;
    result->value_type = 0x7f;
    result->load_opcode = 0x28; /* i32.load */
    result->store_opcode = 0x36; /* i32.store */
    result->alignment = 2;
    result->value_size = 4;
    result->integer_bits = 32;
    return 0;
  case FFI_TYPE_SINT64:
    if (type->size != 8) return -EINVAL;
    result->value_type = 0x7e;
    result->load_opcode = 0x29; /* i64.load */
    result->store_opcode = 0x37; /* i64.store */
    result->alignment = 3;
    result->value_size = 8;
    result->integer_bits = 64;
    result->is_signed = 1;
    return 0;
  case FFI_TYPE_UINT64:
    if (type->size != 8) return -EINVAL;
    result->value_type = 0x7e;
    result->load_opcode = 0x29; /* i64.load */
    result->store_opcode = 0x37; /* i64.store */
    result->alignment = 3;
    result->value_size = 8;
    result->integer_bits = 64;
    return 0;
  case FFI_TYPE_FLOAT:
    if (type->size != 4) return -EINVAL;
    result->value_type = 0x7d;
    result->load_opcode = 0x2a; /* f32.load */
    result->store_opcode = 0x38; /* f32.store */
    result->alignment = 2;
    result->value_size = 4;
    return 0;
  case FFI_TYPE_DOUBLE:
    if (type->size != 8) return -EINVAL;
    result->value_type = 0x7c;
    result->load_opcode = 0x2b; /* f64.load */
    result->store_opcode = 0x39; /* f64.store */
    result->alignment = 3;
    result->value_size = 8;
    return 0;
  case FFI_TYPE_POINTER:
    if (type->size != address_bits / 8) return -EINVAL;
    result->value_type = (unsigned char)pointer_value_type(address_bits);
    result->load_opcode = address_bits == 64 ? 0x29 : 0x28;
    result->store_opcode = address_bits == 64 ? 0x37 : 0x36;
    result->alignment = address_bits == 64 ? 3 : 2;
    result->value_size = (unsigned char)(address_bits / 8);
    return 0;
  default:
    /* Aggregates, complex numbers and long double need a different ABI. */
    return -ENOTSUP;
  }
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
  if (result == 0) result = buffer_u32(body, type->alignment);
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
                             const WasmType *type) {
  int result = emit_integer_result_extension(body, address_bits, type);
  if (result < 0) {
    return result;
  }

  if (type->integer_bits != 0 && type->integer_bits < address_bits) {
    result = buffer_byte(body, address_bits == 64 ? 0x37 : 0x36);
    if (result == 0) result = buffer_u32(body, address_bits == 64 ? 3 : 2);
  } else {
    result = buffer_byte(body, type->store_opcode);
    if (result == 0) result = buffer_u32(body, type->alignment);
  }
  if (result == 0) result = buffer_u32(body, 0);
  return result;
}

static int emit_type_section(ByteBuffer *module, unsigned address_bits, unsigned nargs,
                             const WasmType *return_type, const WasmType *argument_types) {
  ByteBuffer section = {0};
  int result = buffer_u32(&section, 2); /* call type and exported wrapper type */
  if (result == 0) result = buffer_byte(&section, 0x60);
  if (result == 0) result = buffer_u32(&section, nargs);
  for (unsigned i = 0; result == 0 && i < nargs; ++i) {
    result = buffer_byte(&section, argument_types[i].value_type);
  }
  if (result == 0) result = buffer_u32(&section, return_type->value_type == 0 ? 0 : 1);
  if (result == 0 && return_type->value_type != 0) {
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

  /* Keep the result pointer below the call operands for the final store. */
  if (result == 0 && return_type->value_type != 0) {
    result = buffer_byte(&body, 0x20); /* local.get result */
    if (result == 0) result = buffer_u32(&body, 1);
  }

  const uint64_t pointer_size = address_bits / 8;
  for (unsigned i = 0; result == 0 && i < nargs; ++i) {
    result = emit_pointer_local_and_offset(&body, address_bits, 2,
                                           (uint64_t)i * pointer_size);
    if (result == 0) result = emit_load(&body, &(WasmType){
      .load_opcode = address_bits == 64 ? 0x29 : 0x28,
      .alignment = address_bits == 64 ? 3 : 2,
    });
    if (result == 0) result = emit_load(&body, &argument_types[i]);
  }
  if (result == 0) result = buffer_byte(&body, 0x20); /* function table index */
  if (result == 0) result = buffer_u32(&body, 0);
  if (result == 0) result = buffer_byte(&body, 0x11); /* call_indirect */
  if (result == 0) result = buffer_u32(&body, 0); /* specialized call type */
  if (result == 0) result = buffer_u32(&body, 0); /* imported table 0 */
  if (result == 0 && return_type->value_type != 0) {
    result = emit_result_store(&body, address_bits, return_type);
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
  int result = get_wasm_type(return_type, address_bits, 1, &wasm_return);
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
    result = get_wasm_type(argument_types[i], address_bits, 0, &wasm_arguments[i]);
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
