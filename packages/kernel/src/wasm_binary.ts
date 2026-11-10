// SPDX-License-Identifier: MIT

// The WebAssembly JavaScript API reports that an import is a memory, but not
// the memory's limits. Those live in the module's import section, so read the
// small part of the binary format that is needed to recover them.

export interface WasmMemoryType {
  address: "i32" | "i64";
  minimum: bigint;
  maximum?: bigint;
  shared: boolean;
}

export interface WasmMemoryImport {
  module: string;
  name: string;
  type: WasmMemoryType;
}

export interface WasmMemories {
  imports: WasmMemoryImport[];
  definitions: WasmMemoryType[];
}

export interface WasmGlobalImport {
  module: string;
  name: string;
  value: "i32" | "i64" | null;
  mutable: boolean;
}

/** Match the actual host-provided global before exec commits a new image. */
export function user_poll_globals_supported(imports: WasmGlobalImport[], address: "i32" | "i64") {
  return imports.every(
    (entry) =>
      entry.module !== "linux_user_poll_v2" ||
      (entry.name === "thread_pointer" && entry.value === address && entry.mutable),
  );
}

/**
 * Returns the single shared userspace memory import accepted by the runtime.
 * The kernel and userspace module must use one pointer width: mixing memory32
 * and memory64 would otherwise silently narrow syscall and callback values.
 */
export function user_memory_import(
  memories: WasmMemories,
  kernel_address: WasmMemoryType["address"],
): WasmMemoryImport | null {
  const memory_import = memories.imports[0];
  if (
    memories.definitions.length !== 0 ||
    memories.imports.length !== 1 ||
    !memory_import ||
    memory_import.module !== "env" ||
    memory_import.name !== "memory" ||
    memory_import.type.address !== kernel_address ||
    !memory_import.type.shared ||
    memory_import.type.maximum === undefined
  ) {
    return null;
  }
  return memory_import;
}

export class WasmParseError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "WasmParseError";
  }
}

const text_decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

class Cursor {
  readonly #bytes: Uint8Array;
  readonly #end: number;
  #offset: number;

  constructor(bytes: Uint8Array, offset = 0, end = bytes.length) {
    this.#bytes = bytes;
    this.#offset = offset;
    this.#end = end;
  }

  get done() {
    return this.#offset === this.#end;
  }

  get offset() {
    return this.#offset;
  }

  get end() {
    return this.#end;
  }

  byte() {
    if (this.#offset === this.#end) this.fail("unexpected end of module");
    return this.#bytes[this.#offset++]!;
  }

  u32() {
    return Number(this.#unsigned(32));
  }

  u64() {
    return this.#unsigned(64);
  }

  signed32() {
    this.#signed(32);
  }

  signed64() {
    this.#signed(64);
  }

  skip(length: number) {
    if (!Number.isInteger(length) || length < 0 || this.#offset + length > this.#end)
      this.fail("immediate extends past its section");
    this.#offset += length;
  }

  #unsigned(bits: number) {
    let value = 0n;
    const bytes = Math.ceil(bits / 7);

    for (let i = 0; i < bytes; i++) {
      const byte = this.byte();
      const payload = byte & 0x7f;
      const remaining = bits - i * 7;
      if (remaining < 7 && payload >= 1 << remaining) {
        this.fail(`u${bits} LEB128 overflows`);
      }
      value |= BigInt(payload) << BigInt(i * 7);
      if (!(byte & 0x80)) return value;
    }

    this.fail(`u${bits} LEB128 is too long`);
  }

  #signed(bits: number) {
    const count = Math.ceil(bits / 7);
    for (let index = 0; index < count; index++) {
      const byte = this.byte();
      const payload = byte & 0x7f;
      const remaining = bits - index * 7;
      if (!(byte & 0x80)) {
        if (remaining < 7) {
          const used = (1 << remaining) - 1;
          const unused = 0x7f ^ used;
          const sign = 1 << (remaining - 1);
          const extension = payload & sign ? unused : 0;
          if ((payload & unused) !== extension) this.fail(`s${bits} LEB128 overflows`);
        }
        return;
      }
      if (index === count - 1) this.fail(`s${bits} LEB128 is too long`);
    }
  }

  // Heap types can be type indices encoded as s33. Their value is immaterial
  // here, but consuming the complete, bounded encoding lets us skip table and
  // global imports without parsing unrelated type sections.
  signed33(first: number) {
    let byte = first;
    for (let i = 0; i < 5; i++) {
      const payload = byte & 0x7f;
      const remaining = 33 - i * 7;
      if (!(byte & 0x80)) {
        if (remaining < 7) {
          const used = (1 << remaining) - 1;
          const unused = 0x7f ^ used;
          const sign = 1 << (remaining - 1);
          const extension = payload & sign ? unused : 0;
          if ((payload & unused) !== extension) {
            this.fail("s33 LEB128 overflows");
          }
        }
        return;
      }
      if (i === 4) this.fail("s33 LEB128 is too long");
      byte = this.byte();
    }
  }

  span() {
    const length = this.u32();
    const start = this.#offset;
    const end = start + length;
    if (end > this.#end) this.fail("span extends past its section");
    this.#offset = end;
    return new Cursor(this.#bytes, start, end);
  }

  text(): string {
    try {
      return text_decoder.decode(this.view());
    } catch {
      return this.fail("name is not valid UTF-8");
    }
  }

  view() {
    return this.#bytes.subarray(this.#offset, this.#end);
  }

  expect_done(what: string) {
    if (!this.done) this.fail(`trailing bytes in ${what}`);
  }

  fail(message: string): never {
    throw new WasmParseError(message, this.#offset);
  }
}

function read_memory_type(bytes: Cursor): WasmMemoryType {
  const flags = bytes.byte();
  if (flags & ~0x07) bytes.fail("unknown memory limits flags");

  const has_maximum = !!(flags & 0x01);
  const shared = !!(flags & 0x02);
  const address = flags & 0x04 ? "i64" : "i32";
  const read_limit = address === "i64" ? () => bytes.u64() : () => BigInt(bytes.u32());
  const minimum = read_limit();
  const maximum = has_maximum ? read_limit() : undefined;

  return { address, minimum, maximum, shared };
}

function skip_reference_type(bytes: Cursor) {
  const type = bytes.byte();
  if (type === 0x63 || type === 0x64) {
    bytes.signed33(bytes.byte());
  } else if (type < 0x69 || type > 0x74) {
    bytes.fail("invalid reference type");
  }
}

function skip_value_type(bytes: Cursor) {
  const type = bytes.byte();
  if (type >= 0x7b && type <= 0x7f) return type;
  if (type === 0x63 || type === 0x64) {
    bytes.signed33(bytes.byte());
  } else if (type < 0x69 || type > 0x74) {
    bytes.fail("invalid value type");
  }
  return type;
}

function skip_limits(bytes: Cursor) {
  const flags = bytes.byte();
  if (flags & ~0x05) bytes.fail("unknown limits flags");
  const read_limit = flags & 0x04 ? () => bytes.u64() : () => bytes.u32();
  read_limit();
  if (flags & 0x01) read_limit();
}

function read_imports(
  bytes: Cursor,
  imports: WasmMemoryImport[],
  globals?: WasmGlobalImport[],
  functions?: { module: string; name: string; typeIndex: number }[],
) {
  const count = bytes.u32();
  for (let i = 0; i < count; i++) {
    // Keep names as spans until we know this is a memory import. Typical Linux
    // modules have many function imports whose names this reader need not own.
    const module = bytes.span();
    const name = bytes.span();
    switch (bytes.byte()) {
      case 0x00: {
        // function
        const typeIndex = bytes.u32();
        functions?.push({ module: module.text(), name: name.text(), typeIndex });
        break;
      }
      case 0x01: // table
        skip_reference_type(bytes);
        skip_limits(bytes);
        break;
      case 0x02: // memory
        imports.push({
          module: module.text(),
          name: name.text(),
          type: read_memory_type(bytes),
        });
        break;
      case 0x03: {
        // global
        const type = skip_value_type(bytes);
        const mutable = bytes.byte();
        if (mutable > 1) bytes.fail("invalid global mutability");
        globals?.push({
          module: module.text(),
          name: name.text(),
          value: type === 0x7f ? "i32" : type === 0x7e ? "i64" : null,
          mutable: !!mutable,
        });
        break;
      }
      case 0x04: // tag
        if (bytes.byte() !== 0) bytes.fail("unknown tag attribute");
        bytes.u32();
        break;
      default:
        bytes.fail("unknown import type");
    }
  }
  bytes.expect_done("import section");
}

/** Preserve engine-owned function types, including recursive/reference types.
 * A caller may link only these imports without running user start/data/code. */
export function read_wasm_function_import_probe(module: Uint8Array) {
  const bytes = new Cursor(module);
  for (const expected of [0, 97, 115, 109, 1, 0, 0, 0])
    if (bytes.byte() !== expected) bytes.fail("invalid WebAssembly header");
  let types: Uint8Array = new Uint8Array();
  const functions: { module: string; name: string; typeIndex: number }[] = [];
  const definitions: number[] = [];
  let entry: { kind: number; index: number } | undefined;
  while (!bytes.done) {
    const id = bytes.byte(),
      part = bytes.span();
    if (id === 1) types = part.view();
    if (id === 2) read_imports(part, [], undefined, functions);
    if (id === 3) {
      const count = part.u32();
      for (let i = 0; i < count; i++) definitions.push(part.u32());
      part.expect_done("function section");
    }
    if (id === 7) {
      const count = part.u32();
      for (let i = 0; i < count; i++) {
        const name = part.span().text(),
          kind = part.byte(),
          index = part.u32();
        if (name === "_start") entry = { kind, index };
      }
      part.expect_done("export section");
    }
  }
  const entryType =
    entry?.kind === 0
      ? entry.index < functions.length
        ? functions[entry.index]?.typeIndex
        : definitions[entry.index - functions.length]
      : undefined;
  return { types, functions, entryType };
}

function read_definitions(bytes: Cursor, definitions: WasmMemoryType[]) {
  const count = bytes.u32();
  for (let i = 0; i < count; i++) definitions.push(read_memory_type(bytes));
  bytes.expect_done("memory section");
}

export function read_wasm_memories(module: Uint8Array, globals?: WasmGlobalImport[]): WasmMemories {
  const bytes = new Cursor(module);
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const expected of header) {
    if (bytes.byte() !== expected) bytes.fail("invalid WebAssembly header");
  }

  const memories: WasmMemories = { imports: [], definitions: [] };
  let saw_imports = false;
  let saw_definitions = false;
  while (!bytes.done) {
    const id = bytes.byte();
    const section = bytes.span();
    if (id === 2) {
      if (saw_imports) bytes.fail("duplicate import section");
      saw_imports = true;
      read_imports(section, memories.imports, globals);
    } else if (id === 5) {
      if (saw_definitions) bytes.fail("duplicate memory section");
      saw_definitions = true;
      read_definitions(section, memories.definitions);
    }
  }

  return memories;
}

export interface WasmTableType {
  address: "i32" | "i64";
  minimum: bigint;
  maximum?: bigint;
}

/** A static main owns one exported table; side modules import that resource. */
export function read_wasm_main_table(module: Uint8Array): WasmTableType {
  const bytes = new Cursor(module, 8);
  while (!bytes.done) {
    const id = bytes.byte();
    const part = bytes.span();
    if (id !== 4) continue;
    if (part.u32() !== 1 || part.byte() !== 0x70)
      part.fail("dynamic main requires one funcref table");
    const flags = part.byte();
    if (flags & ~5) part.fail("unsupported main table type");
    const address = flags & 4 ? "i64" : "i32";
    const limit = () => (address === "i64" ? part.u64() : BigInt(part.u32()));
    const minimum = limit();
    const maximum = flags & 1 ? limit() : undefined;
    part.expect_done("main table section");
    return { address, minimum, maximum };
  }
  return bytes.fail("dynamic main table is missing");
}

export interface WasmDylink {
  memorySize: number;
  memoryAlignment: number;
  tableSize: number;
  tableAlignment: number;
  needed: string[];
  runtimePaths: string[];
  exports: { name: string; flags: number }[];
  imports: { module: string; name: string; flags: number }[];
  target?: "wasm32" | "wasm64";
  /** A loader must decide whether it can honor extensions before publishing a DSO. */
  unknownSubsections: number[];
}

export type WasmDynamicImport = {
  module: string;
  name: string;
} & (
  | { kind: "function"; typeIndex: number }
  | { kind: "tag"; typeIndex: number }
  | { kind: "memory"; type: WasmMemoryType }
  | { kind: "table"; address: "i32" | "i64"; minimum: bigint; maximum?: bigint }
  | { kind: "global"; value: "i32" | "i64"; mutable: boolean }
);

/** The current native-code dynamic profile accepts integer GOT/base globals, a
 * funcref table and exception tags. Reject other import kinds before allocating
 * process resources. Engine validation is still required for the complete module. */
export function read_wasm_dynamic_imports(
  module: Uint8Array,
  allowDefinedTable = false,
): WasmDynamicImport[] {
  const bytes = new Cursor(module);
  for (const expected of [0, 97, 115, 109, 1, 0, 0, 0])
    if (bytes.byte() !== expected) bytes.fail("invalid WebAssembly header");
  const result: WasmDynamicImport[] = [];
  let seen = false;
  while (!bytes.done) {
    const id = bytes.byte();
    const part = bytes.span();
    if (id === 4 && !allowDefinedTable && part.u32() !== 0)
      part.fail("dynamic module must not define a private table");
    if (id !== 2) continue;
    if (seen) part.fail("duplicate import section");
    seen = true;
    const count = part.u32();
    for (let i = 0; i < count; i++) {
      const module = part.span().text();
      const name = part.span().text();
      switch (part.byte()) {
        case 0:
          result.push({ module, name, kind: "function", typeIndex: part.u32() });
          break;
        case 1: {
          if (part.byte() !== 0x70) part.fail("dynamic table must be funcref");
          const flags = part.byte();
          if (flags & ~5) part.fail("unsupported dynamic table limits");
          const address = flags & 4 ? "i64" : "i32";
          const limit = () => (address === "i64" ? part.u64() : BigInt(part.u32()));
          const minimum = limit();
          const maximum = flags & 1 ? limit() : undefined;
          result.push({ module, name, kind: "table", address, minimum, maximum });
          break;
        }
        case 2:
          result.push({ module, name, kind: "memory", type: read_memory_type(part) });
          break;
        case 3: {
          const type = part.byte();
          const mutable = part.byte();
          if ((type !== 0x7f && type !== 0x7e) || mutable > 1)
            part.fail("unsupported dynamic global type");
          result.push({
            module,
            name,
            kind: "global",
            value: type === 0x7f ? "i32" : "i64",
            mutable: !!mutable,
          });
          break;
        }
        case 4: {
          if (part.byte() !== 0) part.fail("unsupported dynamic tag attribute");
          result.push({ module, name, kind: "tag", typeIndex: part.u32() });
          break;
        }
        default:
          part.fail("unsupported dynamic import kind");
      }
    }
    part.expect_done("dynamic import section");
  }
  return result;
}

export const dynamic_tail_table_import = "__wasm_private_tail_function_table";
const dynamic_tail_abi_section = "linux.dylink.tail.v1";

/** Read the opt-in marker for the first dynamic tail-call execution ABI. */
export function read_wasm_dynamic_tail_abi(module: Uint8Array): boolean {
  const bytes = new Cursor(module);
  for (const expected of [0, 97, 115, 109, 1, 0, 0, 0])
    if (bytes.byte() !== expected) bytes.fail("invalid WebAssembly header");
  let version: number | undefined;
  while (!bytes.done) {
    const id = bytes.byte();
    const section = bytes.span();
    if (id !== 0) continue;
    const name = section.span().text();
    if (name !== dynamic_tail_abi_section) continue;
    if (version !== undefined) section.fail("duplicate dynamic tail-call ABI marker");
    if (section.view().length !== 1 || section.byte() !== 1)
      section.fail("unsupported dynamic tail-call ABI marker");
    section.expect_done("dynamic tail-call ABI marker");
    version = 1;
  }
  return version === 1;
}

function encode_u32(value: number): number[] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw new WasmParseError("u32 value overflows", 0);
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function encode_u64(value: bigint): number[] {
  if (value < 0n || value > 0xffffffffffffffffn) throw new WasmParseError("u64 value overflows", 0);
  const bytes: number[] = [];
  do {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function join_bytes(parts: readonly Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (length > 0xffffffff) throw new WasmParseError("WebAssembly section exceeds u32", 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encode_section(id: number, payload: Uint8Array) {
  return join_bytes([new Uint8Array([id, ...encode_u32(payload.length)]), payload]);
}

function encode_name(name: string) {
  const encoded = new TextEncoder().encode(name);
  return new Uint8Array([...encode_u32(encoded.length), ...encoded]);
}

function read_block_type(bytes: Cursor) {
  bytes.signed33(bytes.byte());
}

function read_memory_argument(bytes: Cursor, address: WasmMemoryType["address"]) {
  const alignment = bytes.u32();
  if (alignment & 0x40) {
    const memory = bytes.u32();
    if (memory !== 0) bytes.fail("dynamic tail-call ABI does not support multiple memories");
  }
  if (address === "i64") bytes.u64();
  else bytes.u32();
}

function read_canonical_table_index(bytes: Cursor, privateTable: boolean) {
  const index = bytes.u32();
  if (index !== 0 || privateTable)
    bytes.fail("dynamic tail-call ABI reserves the shadow table for tail calls");
}

function read_simd_instruction(bytes: Cursor, address: WasmMemoryType["address"]) {
  const opcode = bytes.u32();
  const known =
    opcode <= 0x99 ||
    (opcode >= 0x9b && opcode <= 0x9f) ||
    (opcode >= 0xa0 && opcode <= 0xa4) ||
    (opcode >= 0xa7 && opcode <= 0xae) ||
    opcode === 0xb1 ||
    (opcode >= 0xb5 && opcode <= 0xba) ||
    (opcode >= 0xbc && opcode <= 0xc4) ||
    (opcode >= 0xc7 && opcode <= 0xce) ||
    opcode === 0xd1 ||
    (opcode >= 0xd5 && opcode <= 0xe1) ||
    (opcode >= 0xe3 && opcode <= 0xed) ||
    (opcode >= 0xef && opcode <= 0xff) ||
    (opcode >= 0x100 && opcode <= 0x113);
  if (!known) bytes.fail(`unsupported SIMD instruction 0xfd ${opcode}`);
  if (opcode <= 0x0b || (opcode >= 0x54 && opcode <= 0x5d)) {
    read_memory_argument(bytes, address);
    if (opcode >= 0x54 && opcode <= 0x5b) bytes.byte();
  } else if (opcode === 0x0c || opcode === 0x0d) bytes.skip(16);
  else if (opcode >= 0x15 && opcode <= 0x22) bytes.byte();
}

function read_prefixed_instruction(
  bytes: Cursor,
  prefix: number,
  address: WasmMemoryType["address"],
) {
  if (prefix === 0xfd) {
    read_simd_instruction(bytes, address);
    return;
  }
  const opcode = bytes.u32();
  if (prefix === 0xfc) {
    if (opcode <= 7) return;
    switch (opcode) {
      case 8:
        bytes.u32();
        if (bytes.u32() !== 0)
          bytes.fail("dynamic tail-call ABI does not support multiple memories");
        return;
      case 9:
      case 13:
        bytes.u32();
        return;
      case 10:
        if (bytes.u32() !== 0 || bytes.u32() !== 0)
          bytes.fail("dynamic tail-call ABI does not support multiple memories");
        return;
      case 11:
        if (bytes.u32() !== 0)
          bytes.fail("dynamic tail-call ABI does not support multiple memories");
        return;
      case 12:
        bytes.u32();
        read_canonical_table_index(bytes, false);
        bytes.fail("dynamic tail-call ABI does not support table.init");
      case 14:
        read_canonical_table_index(bytes, false);
        read_canonical_table_index(bytes, false);
        bytes.fail("dynamic tail-call ABI does not support table.copy");
      case 15:
        read_canonical_table_index(bytes, false);
        bytes.fail("dynamic tail-call ABI does not support table.grow");
      case 16:
        read_canonical_table_index(bytes, false);
        return;
      case 17:
        read_canonical_table_index(bytes, false);
        bytes.fail("dynamic tail-call ABI does not support table.fill");
      default:
        bytes.fail(`unsupported 0xfc instruction ${opcode}`);
    }
  }
  if (prefix === 0xfe) {
    if (opcode === 3) {
      if (bytes.byte() !== 0) bytes.fail("invalid atomic.fence immediate");
      return;
    }
    if (opcode <= 2 || (opcode >= 0x10 && opcode <= 0x4e)) {
      read_memory_argument(bytes, address);
      return;
    }
    bytes.fail(`unsupported atomic instruction 0xfe ${opcode}`);
  }
  bytes.fail(`unsupported instruction prefix 0x${prefix.toString(16)}`);
}

type TailCallPatch = { start: number; end: number };

function decode_dynamic_function_body(
  body: Cursor,
  source: Uint8Array,
  address: WasmMemoryType["address"],
  privateTable: boolean,
  importedFunctions: number,
) {
  const bodyStart = body.offset;
  const patches: TailCallPatch[] = [];
  let tailCalls = 0;
  const localGroups = body.u32();
  for (let index = 0; index < localGroups; index++) {
    body.u32();
    skip_value_type(body);
  }
  while (!body.done) {
    const opcode = body.byte();
    switch (opcode) {
      case 0x00: // unreachable
      case 0x01: // nop
      case 0x05: // else
      case 0x0a: // throw_ref
      case 0x0b: // end
      case 0x0f: // return
      case 0x1a: // drop
      case 0x1b: // select
      case 0x19: // catch_all
      case 0xd1: // ref.is_null
      case 0xd3: // ref.eq
      case 0xd4: // ref.as_non_null
        break;
      case 0x02: // block
      case 0x03: // loop
      case 0x04: // if
      case 0x06: // try
        read_block_type(body);
        break;
      case 0x07: // catch
      case 0x08: // throw
        body.u32();
        break;
      case 0x09: // rethrow
      case 0x0c: // br
      case 0x0d: // br_if
      case 0x18: // delegate
      case 0xd5: // br_on_null
      case 0xd6: // br_on_non_null
        body.u32();
        break;
      case 0x0e: {
        const labels = body.u32();
        for (let index = 0; index <= labels; index++) body.u32();
        break;
      }
      case 0x10: // call
      case 0x20: // local.get
      case 0x21: // local.set
      case 0x22: // local.tee
      case 0x23: // global.get
      case 0x24: // global.set
      case 0xd2: // ref.func
        body.u32();
        break;
      case 0x12: {
        // return_call
        const functionIndex = body.u32();
        if (functionIndex < importedFunctions)
          body.fail("dynamic tail-call ABI does not support return_call to an imported function");
        break;
      }
      case 0x11: // call_indirect
        body.u32(); // type index
        read_canonical_table_index(body, privateTable);
        break;
      case 0x13: {
        // return_call_indirect
        body.u32(); // type index
        const start = body.offset;
        const tableIndex = body.u32();
        const end = body.offset;
        if (tableIndex === 0) patches.push({ start, end });
        else if (tableIndex !== 1 || !privateTable)
          body.fail("dynamic tail-call ABI does not support multiple tables");
        tailCalls++;
        break;
      }
      case 0x14: // call_ref
        body.u32();
        break;
      case 0x15: // return_call_ref
        body.fail("dynamic tail-call ABI does not support return_call_ref");
      case 0x1c: {
        const types = body.u32();
        for (let index = 0; index < types; index++) skip_value_type(body);
        break;
      }
      case 0x1f: {
        // try_table
        read_block_type(body);
        const catches = body.u32();
        for (let index = 0; index < catches; index++) {
          const kind = body.byte();
          if (kind === 0 || kind === 1)
            body.u32(); // tag index
          else if (kind !== 2 && kind !== 3) body.fail("invalid try_table catch kind");
          body.u32(); // label index
        }
        break;
      }
      case 0x25: // table.get
        read_canonical_table_index(body, privateTable);
        break;
      case 0x26: // table.set
        read_canonical_table_index(body, privateTable);
        body.fail("dynamic tail-call ABI does not support table.set");
      default:
        if (opcode >= 0x28 && opcode <= 0x3e) read_memory_argument(body, address);
        else if (opcode === 0x3f || opcode === 0x40) {
          if (body.u32() !== 0)
            body.fail("dynamic tail-call ABI does not support multiple memories");
        } else if (opcode === 0x41) body.signed32();
        else if (opcode === 0x42) body.signed64();
        else if (opcode === 0x43) body.skip(4);
        else if (opcode === 0x44) body.skip(8);
        else if (opcode === 0xd0) body.signed33(body.byte());
        else if (opcode === 0xfc || opcode === 0xfd || opcode === 0xfe) {
          read_prefixed_instruction(body, opcode, address);
        } else if (opcode >= 0x45 && opcode <= 0xc4) {
          // Numeric and sign-extension instructions have no immediates.
        } else body.fail(`unsupported dynamic tail-call instruction 0x${opcode.toString(16)}`);
    }
  }
  if (source[body.end - 1] !== 0x0b) body.fail("function body does not end with end");
  if (!patches.length) return { bytes: source.subarray(bodyStart, body.end), tailCalls };
  const parts: Uint8Array[] = [];
  let offset = bodyStart;
  for (const patch of patches) {
    parts.push(source.subarray(offset, patch.start), new Uint8Array(encode_u32(1)));
    offset = patch.end;
  }
  parts.push(source.subarray(offset, body.end));
  return { bytes: join_bytes(parts), tailCalls };
}

function read_import_section_entries(section: Cursor) {
  const count = section.u32();
  const entriesStart = section.offset;
  for (let index = 0; index < count; index++) {
    section.span(); // module name
    section.span(); // import name
    switch (section.byte()) {
      case 0:
        section.u32();
        break;
      case 1:
        skip_reference_type(section);
        skip_limits(section);
        break;
      case 2:
        read_memory_type(section);
        break;
      case 3:
        skip_value_type(section);
        if (section.byte() > 1) section.fail("invalid global mutability");
        break;
      case 4:
        if (section.byte() !== 0) section.fail("invalid tag attribute");
        section.u32();
        break;
      default:
        section.fail("invalid import kind");
    }
  }
  const entriesEnd = section.offset;
  section.expect_done("import section");
  return { count, entriesStart, entriesEnd };
}

export interface PreparedDynamicTailCalls {
  bytes: Uint8Array<ArrayBuffer>;
  enabled: boolean;
  redirectedCalls: number;
  tailTableRequired: boolean;
}

/** Strictly decode and redirect ABI-v1 side-module return_call_indirect calls.
 * Main-module, direct-import, return_call_ref and multi-table calls are outside
 * this ABI. Unknown instructions, table mutation and core start sections fail
 * before process resources are published. Import the shadow table only when a
 * marked module actually contains redirected calls.
 */
export function prepare_wasm_dynamic_tail_calls(module: Uint8Array): PreparedDynamicTailCalls {
  const source = new Uint8Array(module);
  const enabled = read_wasm_dynamic_tail_abi(source);
  const imports = read_wasm_dynamic_imports(source);
  const tableImports = imports.filter(
    (entry): entry is Extract<WasmDynamicImport, { kind: "table" }> => entry.kind === "table",
  );
  const reservedImports = tableImports.filter(
    (entry) => entry.module === "env" && entry.name === dynamic_tail_table_import,
  );
  if (!enabled) {
    if (reservedImports.length) throw new Error("dynamic tail table import requires ABI marker");
    return { bytes: source, enabled: false, redirectedCalls: 0, tailTableRequired: false };
  }
  if (reservedImports.length)
    throw new Error("dynamic tail table import is reserved for loader transformation");

  let canonical = 0;
  let canonicalTable: Extract<WasmDynamicImport, { kind: "table" }> | undefined;
  for (const entry of tableImports) {
    if (entry.module === "env" && entry.name === "__indirect_function_table") {
      canonical++;
      canonicalTable = entry;
    } else throw new Error("dynamic tail-call ABI does not support multiple tables");
  }
  if (canonical !== 1 || !canonicalTable)
    throw new Error("dynamic tail-call ABI requires one canonical function table");
  const memories = imports.filter(
    (entry): entry is Extract<WasmDynamicImport, { kind: "memory" }> => entry.kind === "memory",
  );
  const importedFunctions = imports.filter((entry) => entry.kind === "function").length;
  if (memories.length > 1)
    throw new Error("dynamic tail-call ABI does not support multiple memories");
  const address = memories[0]?.type.address ?? "i32";
  let importSection: { start: number; end: number; payload: Cursor } | undefined;
  let codeSection: { start: number; end: number; payload: Uint8Array } | undefined;
  const input = new Cursor(source, 8);
  let redirectedCalls = 0;
  while (!input.done) {
    const start = input.offset;
    const id = input.byte();
    const section = input.span();
    const end = input.offset;
    if (id === 8) throw new Error("dynamic tail-call ABI does not support a Wasm start section");
    if (id === 2) {
      if (importSection) section.fail("duplicate import section");
      importSection = { start, end, payload: section };
    }
    if (id !== 10) continue;
    if (codeSection) section.fail("duplicate code section");
    const count = section.u32();
    const bodies: Uint8Array[] = [new Uint8Array(encode_u32(count))];
    for (let index = 0; index < count; index++) {
      const body = section.span();
      const decoded = decode_dynamic_function_body(body, source, address, false, importedFunctions);
      redirectedCalls += decoded.tailCalls;
      bodies.push(new Uint8Array(encode_u32(decoded.bytes.length)), decoded.bytes);
    }
    section.expect_done("code section");
    codeSection = { start, end, payload: join_bytes(bodies) };
  }
  if (redirectedCalls === 0)
    return { bytes: source, enabled: true, redirectedCalls: 0, tailTableRequired: false };
  if (!importSection || !codeSection)
    throw new Error("dynamic tail-call ABI requires import and code sections");

  const importPayload = new Cursor(source, importSection.payload.offset, importSection.payload.end);
  const importEntries = read_import_section_entries(importPayload);
  const rawEntries = source.subarray(importEntries.entriesStart, importEntries.entriesEnd);
  const tableFlags =
    (canonicalTable.address === "i64" ? 4 : 0) | (canonicalTable.maximum === undefined ? 0 : 1);
  const tableLimits = [
    tableFlags,
    ...(canonicalTable.address === "i64"
      ? encode_u64(canonicalTable.minimum)
      : encode_u32(Number(canonicalTable.minimum))),
    ...(canonicalTable.maximum === undefined
      ? []
      : canonicalTable.address === "i64"
        ? encode_u64(canonicalTable.maximum)
        : encode_u32(Number(canonicalTable.maximum))),
  ];
  const privateTableImport = new Uint8Array([
    ...encode_name("env"),
    ...encode_name(dynamic_tail_table_import),
    1, // table import
    0x70, // funcref
    ...tableLimits,
  ]);
  const newImportPayload = join_bytes([
    new Uint8Array(encode_u32(importEntries.count + 1)),
    rawEntries,
    privateTableImport,
  ]);
  const newImportSection = encode_section(2, newImportPayload);
  const newCodeSection = encode_section(10, codeSection.payload);
  const replacements = new Map([
    [importSection.start, { end: importSection.end, bytes: newImportSection }],
    [codeSection.start, { end: codeSection.end, bytes: newCodeSection }],
  ]);
  const parts: Uint8Array[] = [source.subarray(0, 8)];
  let offset = 8;
  while (offset < source.length) {
    const id = source[offset]!;
    const replacement = replacements.get(offset);
    if (replacement) {
      parts.push(replacement.bytes);
      offset = replacement.end;
      continue;
    }
    const section = new Cursor(source, offset);
    section.byte();
    section.span();
    parts.push(source.subarray(offset, section.offset));
    offset = section.offset;
  }
  const bytes = join_bytes(parts);
  new WebAssembly.Module(bytes);
  return { bytes, enabled: true, redirectedCalls, tailTableRequired: true };
}

export interface WasmDynamicFunctionReexport {
  module: string;
  name: string;
}

export interface WasmDynamicSignatures {
  exports: Map<string, string>;
  functions: readonly string[];
  imports: readonly (Extract<WasmDynamicImport, { kind: "function" }> & { signature: string })[];
  tagImports: readonly (Extract<WasmDynamicImport, { kind: "tag" }> & { signature: string })[];
  tagExports: Map<string, string>;
  reexports: ReadonlyMap<string, WasmDynamicFunctionReexport>;
}

/** Function and tag ABI identities for the numeric C/SIMD dynamic profile. Do not
 * let a JS forwarding function erase a producer/consumer signature mismatch.
 * Function re-exports retain their imported identity for linker alias handling. */
export function read_wasm_dynamic_signatures(
  module: Uint8Array,
  allowDefinedTable = false,
): WasmDynamicSignatures {
  const dynamicImports = read_wasm_dynamic_imports(module, allowDefinedTable);
  const imports = dynamicImports.filter(
    (entry): entry is Extract<WasmDynamicImport, { kind: "function" }> => entry.kind === "function",
  );
  const tagImports = dynamicImports.filter(
    (entry): entry is Extract<WasmDynamicImport, { kind: "tag" }> => entry.kind === "tag",
  );
  const functions = imports.map((entry) => entry.typeIndex);
  const types: { signature: string; results: number[] }[] = [];
  const definedTags: number[] = [];
  const exports = new Map<string, string>();
  const tagExports = new Map<string, string>();
  const reexports = new Map<string, WasmDynamicFunctionReexport>();
  const bytes = new Cursor(module, 8);
  while (!bytes.done) {
    const id = bytes.byte();
    const part = bytes.span();
    if (id === 1) {
      const count = part.u32();
      for (let index = 0; index < count; index++) {
        if (part.byte() !== 0x60) part.fail("unsupported dynamic function type");
        const parameters = [...part.span().view()];
        const results = [...part.span().view()];
        if ([...parameters, ...results].some((type) => type < 0x7b || type > 0x7f))
          part.fail("dynamic function parameters/results must be numeric values");
        types.push({ signature: JSON.stringify([parameters, results]), results });
      }
      part.expect_done("dynamic type section");
    } else if (id === 3) {
      const count = part.u32();
      for (let index = 0; index < count; index++) functions.push(part.u32());
      part.expect_done("dynamic function section");
    } else if (id === 13) {
      const count = part.u32();
      for (let index = 0; index < count; index++) {
        if (part.byte() !== 0) part.fail("unsupported dynamic tag attribute");
        definedTags.push(part.u32());
      }
      part.expect_done("dynamic tag section");
    } else if (id === 7) {
      const count = part.u32();
      for (let index = 0; index < count; index++) {
        const name = part.span().text();
        const kind = part.byte();
        const position = part.u32();
        if (kind === 0) {
          const type = functions[position];
          const signature =
            (type === undefined ? undefined : types[type]?.signature) ??
            part.fail("invalid dynamic export function type");
          exports.set(name, signature);
          if (position < imports.length) {
            const imported = imports[position]!;
            reexports.set(name, { module: imported.module, name: imported.name });
          }
        } else if (kind === 4) {
          const typeIndex =
            position < tagImports.length
              ? tagImports[position]?.typeIndex
              : definedTags[position - tagImports.length];
          const type =
            (typeIndex === undefined ? undefined : types[typeIndex]) ??
            part.fail("invalid dynamic export tag type");
          if (type.results.length !== 0) part.fail("dynamic tag type must have no results");
          tagExports.set(name, type.signature);
        }
      }
      part.expect_done("dynamic export section");
    }
  }
  for (const typeIndex of definedTags) {
    const type = types[typeIndex] ?? bytes.fail("invalid dynamic tag type");
    if (type.results.length !== 0) bytes.fail("dynamic tag type must have no results");
  }
  return {
    exports,
    functions: functions.map((type) => {
      return types[type]?.signature ?? bytes.fail("invalid dynamic function type");
    }),
    imports: imports.map((entry) => {
      const signature =
        types[entry.typeIndex]?.signature ?? bytes.fail("invalid dynamic import function type");
      return { ...entry, signature };
    }),
    tagImports: tagImports.map((entry) => {
      const type = types[entry.typeIndex] ?? bytes.fail("invalid dynamic import tag type");
      if (type.results.length !== 0) bytes.fail("dynamic tag type must have no results");
      return { ...entry, signature: type.signature };
    }),
    tagExports,
    reexports,
  };
}

/** Read tool-conventions dylink.0, not ELF and not an authorization to instantiate.
 * All names and vectors are bounded by their subsection; custom sections are not
 * validated by the engine. Preserve symbol flags (including weak and TLS) for
 * the loader's capability checks rather than silently discarding them. */
export function read_wasm_dylink(module: WebAssembly.Module): WasmDylink | null {
  const sections = WebAssembly.Module.customSections(module, "dylink.0");
  if (!sections.length) return null;
  if (sections.length !== 1) throw new WasmParseError("duplicate dylink.0 section", 0);
  const bytes = new Cursor(new Uint8Array(sections[0]!));
  const result: WasmDylink = {
    memorySize: 0,
    memoryAlignment: 0,
    tableSize: 0,
    tableAlignment: 0,
    needed: [],
    runtimePaths: [],
    exports: [],
    imports: [],
    unknownSubsections: [],
  };
  let memory_info = false;
  const name = (part: Cursor, empty = false) => {
    const value = part.span().text();
    if ((!empty && !value.length) || value.includes("\0")) part.fail("invalid dylink name");
    return value;
  };
  const vector = (part: Cursor, entry: () => void) => {
    const count = part.u32();
    // Even an empty string entry needs a length byte. Do not iterate a hostile
    // u32 count before discovering that its payload cannot contain the entries.
    if (count > part.view().length) part.fail("impossible dylink vector count");
    for (let i = 0; i < count; i++) entry();
  };
  while (!bytes.done) {
    const id = bytes.byte();
    const part = bytes.span();
    switch (id) {
      case 1:
        if (memory_info) part.fail("duplicate dylink memory info");
        memory_info = true;
        result.memorySize = part.u32();
        result.memoryAlignment = part.u32();
        result.tableSize = part.u32();
        result.tableAlignment = part.u32();
        break;
      case 2:
        vector(part, () => result.needed.push(name(part)));
        break;
      case 3:
        vector(part, () => result.exports.push({ name: name(part), flags: part.u32() }));
        break;
      case 4:
        vector(part, () =>
          result.imports.push({ module: name(part), name: name(part), flags: part.u32() }),
        );
        break;
      case 5:
        vector(part, () => result.runtimePaths.push(name(part, true)));
        break;
      case 6: {
        if (result.target !== undefined) part.fail("duplicate dylink target");
        const target = name(part);
        if (target === "wasm32" || target === "wasm64") result.target = target;
        else part.fail("unknown dylink target");
        break;
      }
      default:
        result.unknownSubsections.push(id);
        continue;
    }
    part.expect_done("dylink subsection");
  }
  if (!memory_info) bytes.fail("missing dylink memory info");
  return result;
}
