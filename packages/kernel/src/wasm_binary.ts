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
  | { kind: "memory"; type: WasmMemoryType }
  | { kind: "table"; address: "i32" | "i64"; minimum: bigint; maximum?: bigint }
  | { kind: "global"; value: "i32" | "i64"; mutable: boolean }
);

/** The current native-code dynamic profile accepts integer GOT/base globals and
 * a funcref table. Reject other import kinds before allocating process resources.
 * Engine validation is still required for the complete module and signatures. */
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
        default:
          part.fail("unsupported dynamic import kind");
      }
    }
    part.expect_done("dynamic import section");
  }
  return result;
}

/** Function ABI identities for the numeric C/SIMD dynamic profile. Do not let a JS
 * forwarding function erase a producer/consumer signature mismatch. Imported
 * function re-exports need scope/alias handling and are rejected by this profile. */
export function read_wasm_dynamic_signatures(module: Uint8Array, allowDefinedTable = false) {
  const imports = read_wasm_dynamic_imports(module, allowDefinedTable).filter(
    (entry) => entry.kind === "function",
  );
  const functions = imports.map((entry) => entry.typeIndex);
  const types: string[] = [];
  const exports = new Map<string, string>();
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
        types.push(JSON.stringify([parameters, results]));
      }
      part.expect_done("dynamic type section");
    } else if (id === 3) {
      const count = part.u32();
      for (let index = 0; index < count; index++) functions.push(part.u32());
      part.expect_done("dynamic function section");
    } else if (id === 7) {
      const count = part.u32();
      for (let index = 0; index < count; index++) {
        const name = part.span().text();
        const kind = part.byte();
        const position = part.u32();
        if (kind !== 0) continue;
        if (position < imports.length)
          part.fail("dynamic function re-exports are not supported yet");
        const type = functions[position];
        const signature = type === undefined ? undefined : types[type];
        if (signature === undefined) part.fail("invalid dynamic export function type");
        exports.set(name, signature!);
      }
      part.expect_done("dynamic export section");
    }
  }
  return {
    exports,
    imports: imports.map((entry) => {
      const signature = types[entry.typeIndex];
      if (signature === undefined) bytes.fail("invalid dynamic import function type");
      return { ...entry, signature: signature! };
    }),
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
