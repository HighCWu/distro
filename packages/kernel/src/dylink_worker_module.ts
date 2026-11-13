// SPDX-License-Identifier: MIT
import { read_wasm_dynamic_imports, read_wasm_dylink } from "./wasm_binary.ts";

/** Errors raised while preparing a fixed module graph for a fresh Worker. */
export class DylinkWorkerModuleError extends Error {
  constructor(message: string, offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = "DylinkWorkerModuleError";
  }
}

class Reader {
  readonly #bytes: Uint8Array<ArrayBuffer>;
  readonly #end: number;
  #offset: number;

  constructor(bytes: Uint8Array<ArrayBuffer>, start = 0, end = bytes.length) {
    this.#bytes = bytes;
    this.#offset = start;
    this.#end = end;
  }

  get offset() {
    return this.#offset;
  }

  get end() {
    return this.#end;
  }

  get done() {
    return this.#offset === this.#end;
  }

  peek() {
    return this.#offset < this.#end ? this.#bytes[this.#offset]! : undefined;
  }

  byte() {
    if (this.#offset >= this.#end) return this.fail("unexpected end of module");
    return this.#bytes[this.#offset++]!;
  }

  u32() {
    let value = 0n;
    for (let index = 0; index < 5; index++) {
      const byte = this.byte();
      const payload = byte & 0x7f;
      const remaining = 32 - index * 7;
      if (remaining < 7 && payload >= 1 << remaining) return this.fail("u32 LEB128 overflows");
      value |= BigInt(payload) << BigInt(index * 7);
      if ((byte & 0x80) === 0) return Number(value);
    }
    return this.fail("u32 LEB128 is too long");
  }

  signed(bits: 32 | 33 | 64) {
    const maximumBytes = Math.ceil(bits / 7);
    let value = 0n;
    let shift = 0n;
    for (let index = 0; index < maximumBytes; index++) {
      const byte = this.byte();
      value |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (byte & 0x40) value |= -1n << shift;
        const minimum = -(1n << BigInt(bits - 1));
        const maximum = (1n << BigInt(bits - 1)) - 1n;
        if (value < minimum || value > maximum) return this.fail(`s${bits} LEB128 overflows`);
        return value;
      }
    }
    return this.fail(`s${bits} LEB128 is too long`);
  }

  bytes(length: number) {
    if (!Number.isInteger(length) || length < 0 || length > this.#end - this.#offset)
      return this.fail("immediate extends past its section");
    const start = this.#offset;
    this.#offset += length;
    return this.#bytes.subarray(start, this.#offset);
  }

  remaining() {
    return this.#end - this.#offset;
  }

  slice(start: number, end: number) {
    if (start < 0 || end < start || end > this.#bytes.length)
      return this.fail("invalid source byte range");
    return this.#bytes.slice(start, end);
  }

  section() {
    const length = this.u32();
    if (length > this.#end - this.#offset) return this.fail("section extends past its parent");
    const start = this.#offset;
    this.#offset += length;
    return new Reader(this.#bytes, start, this.#offset);
  }

  text() {
    const length = this.u32();
    const offset = this.#offset;
    const bytes = this.bytes(length);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return this.failAt("custom section name is not valid UTF-8", offset);
    }
  }

  expectDone(what: string) {
    if (!this.done) this.fail(`trailing bytes in ${what}`);
  }

  fail(message: string): never {
    throw new DylinkWorkerModuleError(message, this.#offset);
  }

  private failAt(message: string, offset: number): never {
    throw new DylinkWorkerModuleError(message, offset);
  }
}

function encodeU32(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new DylinkWorkerModuleError("u32 value overflows", 0);
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return new Uint8Array(bytes);
}

function concatenate(parts: readonly Uint8Array<ArrayBuffer>[]) {
  const length = parts.reduce((total, part) => total + part.length, 0);
  if (!Number.isSafeInteger(length))
    throw new DylinkWorkerModuleError("module size exceeds safe integer range", 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodeSection(id: number, payload: Uint8Array<ArrayBuffer>) {
  return concatenate([new Uint8Array([id]), encodeU32(payload.length), payload]);
}

function skipValueType(reader: Reader) {
  const type = reader.byte();
  if (type === 0x7b || (type >= 0x7c && type <= 0x7f) || type === 0x6f || type === 0x70)
    return type;
  if (type === 0x63 || type === 0x64) {
    reader.signed(33);
    return type;
  }
  if (type >= 0x69 && type <= 0x74) return type;
  reader.fail("invalid global value type");
}

function skipHeapType(reader: Reader) {
  reader.signed(33);
}

type IntegerGlobalInitializer = { opcode: 0x41 | 0x42; value: bigint } | null;

function skipGlobalInitializer(reader: Reader): IntegerGlobalInitializer {
  const opcode = reader.byte();
  let integerValue: bigint | undefined;
  switch (opcode) {
    case 0x41:
      integerValue = reader.signed(32);
      break;
    case 0x42:
      integerValue = reader.signed(64);
      break;
    case 0x43:
      reader.bytes(4);
      break;
    case 0x44:
      reader.bytes(8);
      break;
    case 0x23:
      reader.u32();
      break;
    case 0xd0:
      skipHeapType(reader);
      break;
    case 0xd2:
      reader.u32();
      break;
    case 0xfd:
      if (reader.u32() !== 12) reader.fail("unsupported global SIMD initializer");
      reader.bytes(16);
      break;
    default:
      reader.fail(`unsupported global initializer opcode 0x${opcode.toString(16)}`);
  }
  if (reader.byte() !== 0x0b)
    reader.fail("global initializer must end after one supported constant expression");
  if (opcode === 0x41 || opcode === 0x42) return { opcode, value: integerValue! };
  return null;
}

function validateGlobals(payload: Reader, importedGlobals = 0, allowedMutableGlobal?: number) {
  const count = payload.u32();
  for (let index = 0; index < count; index++) {
    skipValueType(payload);
    const mutable = payload.byte();
    if (mutable > 1) payload.fail("invalid global mutability");
    if (mutable !== 0 && importedGlobals + index !== allowedMutableGlobal)
      payload.fail("fixed Worker module graph does not support defined mutable globals");
    skipGlobalInitializer(payload);
  }
  payload.expectDone("global section");
}

export interface DylinkWorkerEmptyTlsScaffold {
  readonly importedGlobals: number;
  readonly baseGlobalIndex: number;
}

type CoreExport = { kind: number; index: number };
type GlobalDefinition = {
  index: number;
  type: number;
  mutable: boolean;
  initializer: IntegerGlobalInitializer;
};

function readCoreSections(source: Uint8Array<ArrayBuffer>) {
  const reader = new Reader(source);
  for (const expected of [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
    if (reader.byte() !== expected) reader.fail("invalid WebAssembly header");
  const sections = new Map<number, Reader>();
  while (!reader.done) {
    const id = reader.byte();
    const payload = reader.section();
    if (id === 0) {
      payload.text();
      continue;
    }
    if (sections.has(id)) payload.fail(`duplicate core section id ${id}`);
    sections.set(id, payload);
  }
  return sections;
}

function readCoreExports(sections: ReadonlyMap<number, Reader>) {
  const result = new Map<string, CoreExport>();
  const section = sections.get(7);
  if (!section) return result;
  const count = section.u32();
  for (let index = 0; index < count; index++) {
    const name = section.text();
    const kind = section.byte();
    const exportIndex = section.u32();
    if (result.has(name)) section.fail("duplicate WebAssembly export name");
    result.set(name, { kind, index: exportIndex });
  }
  section.expectDone("export section");
  return result;
}

function readGlobalDefinitions(sections: ReadonlyMap<number, Reader>, importedGlobals: number) {
  const result: GlobalDefinition[] = [];
  const section = sections.get(6);
  if (!section) return result;
  const count = section.u32();
  for (let index = 0; index < count; index++) {
    const type = skipValueType(section);
    const mutable = section.byte();
    if (mutable > 1) section.fail("invalid global mutability");
    const initializer = skipGlobalInitializer(section);
    result.push({ index: importedGlobals + index, type, mutable: mutable !== 0, initializer });
  }
  section.expectDone("global section");
  return result;
}

/**
 * Recognize only the empty-TLS exports emitted as linker scaffolding. The
 * mutable base global is safe to recreate only when it is the sole mutable
 * definition, starts at zero, and the immutable size proves that there is no
 * thread-local image to restore.
 */
export function inspect_dylink_worker_empty_tls_scaffold(
  source: Uint8Array<ArrayBuffer>,
  address: "i32" | "i64",
  compiledModule?: WebAssembly.Module,
): DylinkWorkerEmptyTlsScaffold | null {
  const sections = readCoreSections(source);
  const exports = readCoreExports(sections);
  const scaffoldNames = ["__tls_base", "__tls_size", "__tls_align", "__wasm_init_tls"] as const;
  if (!scaffoldNames.some((name) => exports.has(name))) return null;
  const kindByName = new Map<string, number>([
    ["__tls_base", 3],
    ["__tls_size", 3],
    ["__tls_align", 3],
    ["__wasm_init_tls", 0],
  ]);
  for (const name of scaffoldNames) {
    const entry = exports.get(name);
    if (!entry || entry.kind !== kindByName.get(name))
      throw new DylinkWorkerModuleError(
        `incomplete or invalid empty TLS scaffold export ${name}`,
        source.length,
      );
  }

  const module = compiledModule ?? new WebAssembly.Module(source);
  const metadata = read_wasm_dylink(module);
  if (!metadata || metadata.unknownSubsections.length)
    throw new DylinkWorkerModuleError(
      "empty TLS scaffolding requires recognized dylink.0 metadata",
      source.length,
    );
  const reserved = new Set<string>(scaffoldNames);
  if (
    metadata.imports.some((symbol) => (symbol.flags & 0x100) !== 0 || reserved.has(symbol.name)) ||
    metadata.exports.some((symbol) => (symbol.flags & 0x100) !== 0 || reserved.has(symbol.name))
  )
    throw new DylinkWorkerModuleError(
      "dynamic TLS symbols cannot use the empty TLS scaffold path",
      source.length,
    );

  const dynamicImports = read_wasm_dynamic_imports(source);
  if (dynamicImports.some((entry) => reserved.has(entry.name)))
    throw new DylinkWorkerModuleError(
      "empty TLS scaffold exports must be module-local",
      source.length,
    );
  const importedGlobals = dynamicImports.filter((entry) => entry.kind === "global").length;
  const globals = readGlobalDefinitions(sections, importedGlobals);
  const getGlobal = (name: string) => {
    const entry = exports.get(name)!;
    if (entry.index < importedGlobals)
      throw new DylinkWorkerModuleError(
        `empty TLS scaffold global ${name} must be defined by the module`,
        source.length,
      );
    const global = globals.find((item) => item.index === entry.index);
    if (!global)
      throw new DylinkWorkerModuleError(
        `empty TLS scaffold global ${name} is out of range`,
        source.length,
      );
    return global;
  };

  const addressType = address === "i64" ? 0x7e : 0x7f;
  const base = getGlobal("__tls_base");
  const size = getGlobal("__tls_size");
  const align = getGlobal("__tls_align");
  if (
    base.type !== addressType ||
    !base.mutable ||
    base.initializer?.opcode !== (address === "i64" ? 0x42 : 0x41) ||
    base.initializer.value !== 0n ||
    size.type !== addressType ||
    size.mutable ||
    size.initializer?.opcode !== (address === "i64" ? 0x42 : 0x41) ||
    size.initializer.value !== 0n ||
    align.type !== addressType ||
    align.mutable ||
    align.initializer?.opcode !== (address === "i64" ? 0x42 : 0x41) ||
    (align.initializer.value !== 0n && align.initializer.value !== 1n)
  )
    throw new DylinkWorkerModuleError(
      "empty TLS scaffold must have zero size and a zero-initialized base",
      source.length,
    );

  if (globals.some((global) => global.mutable && global.index !== base.index))
    throw new DylinkWorkerModuleError(
      "empty TLS scaffold cannot authorize other defined mutable globals",
      source.length,
    );
  return { importedGlobals, baseGlobalIndex: base.index };
}

function validateStart(payload: Reader) {
  payload.u32();
  payload.expectDone("start section");
}

function validateTags(payload: Reader) {
  const count = payload.u32();
  for (let index = 0; index < count; index++) {
    if (payload.byte() !== 0) payload.fail("unsupported tag attribute");
    payload.u32();
  }
  payload.expectDone("tag section");
}

function skipDataOffsetExpression(payload: Reader) {
  const opcode = payload.byte();
  switch (opcode) {
    case 0x41:
      payload.signed(32);
      break;
    case 0x42:
      payload.signed(64);
      break;
    case 0x23:
      payload.u32();
      break;
    default:
      payload.fail(`unsupported active data offset expression opcode 0x${opcode.toString(16)}`);
  }
  if (payload.byte() !== 0x0b)
    payload.fail("active data offset expression must end after one supported opcode");
}

type WorkerDataSegment = { index: number; passive: boolean; length: number };

function readDataSegments(sections: ReadonlyMap<number, Reader>): WorkerDataSegment[] {
  const section = sections.get(11);
  if (!section) return [];
  const count = section.u32();
  const result: WorkerDataSegment[] = [];
  for (let index = 0; index < count; index++) {
    const flags = section.u32();
    let passive = false;
    if (flags === 0) {
      passive = false;
      skipDataOffsetExpression(section);
    } else if (flags === 1) {
      passive = true;
    } else if (flags === 2) {
      passive = false;
      if (section.u32() !== 0) section.fail("active data segment must target memory index 0");
      skipDataOffsetExpression(section);
    } else {
      section.fail(`unsupported data segment flags ${flags}`);
    }
    const length = section.u32();
    section.bytes(length);
    result.push({ index, passive, length });
  }
  section.expectDone("data section");
  return result;
}

export function has_dylink_worker_passive_data(source: Uint8Array<ArrayBuffer>) {
  return readDataSegments(readCoreSections(source)).some((segment) => segment.passive);
}

function expectByte(reader: Reader, expected: number, description: string) {
  if (reader.byte() !== expected)
    reader.fail(`unrecognized LLD memory initializer: expected ${description}`);
}

function expectU32(reader: Reader, expected: number, description: string) {
  if (reader.u32() !== expected)
    reader.fail(`unrecognized LLD memory initializer: expected ${description}`);
}

function expectLocal(reader: Reader, opcode: number, index: number, description: string) {
  expectByte(reader, opcode, description);
  expectU32(reader, index, description);
}

function expectI32Const(reader: Reader, expected: bigint, description: string) {
  expectByte(reader, 0x41, description);
  if (reader.signed(32) !== expected)
    reader.fail(`unrecognized LLD memory initializer: expected ${description}`);
}

function expectI64Const(reader: Reader, expected: bigint, description: string) {
  expectByte(reader, 0x42, description);
  if (reader.signed(64) !== expected)
    reader.fail(`unrecognized LLD memory initializer: expected ${description}`);
}

function expectPointerConst(reader: Reader, address: "i32" | "i64", description: string) {
  if (address === "i64") {
    expectByte(reader, 0x42, description);
    return reader.signed(64);
  }
  expectByte(reader, 0x41, description);
  return reader.signed(32);
}

function pointerValue(value: bigint, address: "i32" | "i64") {
  return address === "i32" ? BigInt.asUintN(32, value) : value;
}

function expectAtomic(reader: Reader, subopcode: number, description: string) {
  expectByte(reader, 0xfe, description);
  expectU32(reader, subopcode, description);
  expectU32(reader, 2, `${description} alignment`);
  expectU32(reader, 0, `${description} offset`);
}

function readStartFunctionBody(
  sections: ReadonlyMap<number, Reader>,
  functionIndex: number,
  importedFunctions: number,
) {
  if (functionIndex < importedFunctions)
    throw new DylinkWorkerModuleError("LLD memory initializer must be defined", 0);
  const functions = sections.get(3);
  const code = sections.get(10);
  if (!functions || !code)
    throw new DylinkWorkerModuleError("LLD memory initializer has no function body", 0);
  const functionCount = functions.u32();
  for (let index = 0; index < functionCount; index++) functions.u32();
  functions.expectDone("function section");
  const bodyIndex = functionIndex - importedFunctions;
  if (bodyIndex >= functionCount)
    throw new DylinkWorkerModuleError("LLD memory initializer function index is out of range", 0);
  const codeCount = code.u32();
  if (codeCount !== functionCount)
    throw new DylinkWorkerModuleError("function and code section counts disagree", 0);
  let result: Reader | undefined;
  for (let index = 0; index < codeCount; index++) {
    const body = code.section();
    if (index === bodyIndex) result = body;
    else body.bytes(body.remaining());
  }
  code.expectDone("code section");
  if (!result)
    throw new DylinkWorkerModuleError("LLD memory initializer function body is missing", 0);
  return result;
}

/**
 * Recognize only LLD's shared-memory PIC `__wasm_init_memory` state machine.
 * Its branch table targets the init, wait, and drop blocks; the data.drop
 * suffix is outside all three blocks, so every normal path reaches it. Other
 * start functions and any bytecode variation are rejected rather than guessed.
 */
export function inspect_dylink_worker_memory_initializer(
  source: Uint8Array<ArrayBuffer>,
  address: "i32" | "i64",
  compiledModule?: WebAssembly.Module,
): ReadonlySet<number> | null {
  const sections = readCoreSections(source);
  const startSection = sections.get(8);
  if (!startSection) return null;
  const startFunctionIndex = startSection.u32();
  startSection.expectDone("start section");

  const metadata = read_wasm_dylink(compiledModule ?? new WebAssembly.Module(source));
  if (!metadata || metadata.unknownSubsections.length)
    throw new DylinkWorkerModuleError(
      "LLD memory initializer requires recognized dylink.0 metadata",
      source.length,
    );
  if (metadata.target !== undefined && metadata.target !== `wasm${address === "i32" ? 32 : 64}`)
    throw new DylinkWorkerModuleError(
      "LLD memory initializer targets the wrong pointer width",
      source.length,
    );
  if (metadata.memorySize > 0xffff_ffff)
    throw new DylinkWorkerModuleError(
      "LLD memory initializer metadata size is out of range",
      source.length,
    );

  const imports = read_wasm_dynamic_imports(source);
  const importedFunctions = imports.filter((entry) => entry.kind === "function").length;
  const globalImports = imports.filter((entry) => entry.kind === "global");
  const memoryBaseMatches = globalImports.filter(
    (entry) =>
      entry.module === "env" &&
      entry.name === "__memory_base" &&
      entry.value === address &&
      !entry.mutable,
  );
  const memoryImports = imports.filter((entry) => entry.kind === "memory");
  if (
    memoryBaseMatches.length !== 1 ||
    memoryImports.length !== 1 ||
    memoryImports[0]?.module !== "env" ||
    memoryImports[0]?.name !== "memory" ||
    memoryImports[0]?.type.address !== address ||
    !memoryImports[0]?.type.shared ||
    memoryImports[0]?.type.maximum === undefined
  )
    throw new DylinkWorkerModuleError(
      "start function is not LLD's shared-memory PIC initializer",
      source.length,
    );
  const memoryBaseIndex = globalImports.indexOf(memoryBaseMatches[0]!);

  const exports = readCoreExports(sections);
  const namedInitializer = exports.get("__wasm_init_memory");
  if (
    namedInitializer &&
    (namedInitializer.kind !== 0 || namedInitializer.index !== startFunctionIndex)
  )
    throw new DylinkWorkerModuleError(
      "start function is not the exported LLD memory initializer",
      source.length,
    );

  const dataSegments = readDataSegments(sections);
  const passiveSegments = dataSegments
    .filter((segment) => segment.passive)
    .map((segment) => segment.index);
  const passiveByIndex = new Map(
    dataSegments.filter((segment) => segment.passive).map((segment) => [segment.index, segment]),
  );
  const body = readStartFunctionBody(sections, startFunctionIndex, importedFunctions);
  const pointerType = address === "i64" ? 0x7e : 0x7f;
  const pointerConstOpcode = address === "i64" ? 0x42 : 0x41;
  const pointerAdd = address === "i64" ? 0x7c : 0x6a;

  const localGroups = body.u32();
  if (localGroups !== 1 || body.u32() !== 2 || body.byte() !== pointerType)
    body.fail("LLD memory initializer locals do not match the PIC ABI");
  expectLocal(body, 0x23, memoryBaseIndex, "global.get __memory_base");
  const flagOffset = pointerValue(
    expectPointerConst(body, address, "memory initialization flag offset"),
    address,
  );
  if (flagOffset < 0n || flagOffset + 4n !== BigInt(metadata.memorySize))
    body.fail("memory initialization flag is not the final word of the DSO memory image");
  expectByte(body, pointerAdd, "pointer add");
  expectLocal(body, 0x21, 0, "local.set 0");
  for (let index = 0; index < 3; index++) {
    expectByte(body, 0x02, "nested block");
    expectByte(body, 0x40, "empty block type");
  }
  expectLocal(body, 0x20, 0, "local.get 0");
  expectI32Const(body, 0n, "cmpxchg expected value");
  expectI32Const(body, 1n, "cmpxchg desired value");
  expectAtomic(body, 0x48, "i32.atomic.rmw.cmpxchg");
  expectByte(body, 0x0e, "br_table");
  expectU32(body, 2, "br_table label count");
  expectU32(body, 0, "br_table init label");
  expectU32(body, 1, "br_table wait label");
  expectU32(body, 2, "br_table drop label");
  expectByte(body, 0x0b, "end init block");

  const initializedData: number[] = [];
  const initializedRanges: { begin: bigint; end: bigint }[] = [];
  while (body.peek() === 0x41 || body.peek() === 0x42) {
    const destination = pointerValue(
      expectPointerConst(body, address, "initialized memory destination"),
      address,
    );
    if (destination < 0n) body.fail("memory initialization destination is negative");
    expectLocal(body, 0x23, memoryBaseIndex, "global.get __memory_base");
    expectByte(body, pointerAdd, "pointer add");
    if (body.peek() !== 0x41) body.fail("TLS base mutation or unrecognized start operation");
    const firstValue = (() => {
      expectByte(body, 0x41, "memory.init source or memory.fill value");
      return body.signed(32);
    })();
    const secondOpcode = body.byte();
    let secondValue = 0n;
    if (secondOpcode === 0x41) {
      secondValue = body.signed(32);
    } else if (address === "i64" && secondOpcode === 0x42) {
      secondValue = body.signed(64);
    } else {
      body.fail("memory.init or memory.fill length has the wrong pointer width");
    }
    expectByte(body, 0xfc, "bulk-memory instruction");
    const bulkOpcode = body.u32();
    if (bulkOpcode === 8) {
      if (firstValue !== 0n || secondOpcode !== 0x41)
        body.fail("LLD memory.init source or length is not canonical");
      const segmentIndex = body.u32();
      expectU32(body, 0, "memory.init memory index");
      const segment = passiveByIndex.get(segmentIndex);
      const length = BigInt.asUintN(32, secondValue);
      if (!segment || BigInt(segment.length) !== length)
        body.fail("LLD memory.init does not match a passive data segment");
      if (destination + length > flagOffset)
        body.fail("LLD memory.init destination is outside the DSO memory image");
      initializedData.push(segmentIndex);
      initializedRanges.push({ begin: destination, end: destination + length });
    } else if (bulkOpcode === 11) {
      if (firstValue !== 0n || secondOpcode !== pointerConstOpcode)
        body.fail("LLD memory.fill must use zero and a pointer-sized length");
      expectU32(body, 0, "memory.fill memory index");
      const fillSize = pointerValue(secondValue, address);
      if (destination + fillSize < destination || destination + fillSize > flagOffset)
        body.fail("LLD memory.fill destination is outside the DSO memory image");
      initializedRanges.push({ begin: destination, end: destination + fillSize });
    } else {
      body.fail("unrecognized LLD memory initialization instruction");
    }
  }
  if (
    initializedData.length !== passiveSegments.length ||
    initializedData.some((index, offset) => index !== passiveSegments[offset])
  )
    body.fail("LLD initializer does not initialize every passive data segment exactly once");

  expectLocal(body, 0x20, 0, "local.get 0");
  expectI32Const(body, 2n, "initialized flag value");
  expectAtomic(body, 0x17, "i32.atomic.store");
  expectLocal(body, 0x20, 0, "local.get 0");
  expectI32Const(body, -1n, "atomic.notify waiter count");
  expectAtomic(body, 0x00, "memory.atomic.notify");
  expectByte(body, 0x1a, "drop notify result");
  expectByte(body, 0x0c, "branch to drop block");
  expectU32(body, 1, "drop block label");
  expectByte(body, 0x0b, "end wait block");
  expectLocal(body, 0x20, 0, "local.get 0");
  expectI32Const(body, 1n, "atomic.wait32 expected value");
  expectI64Const(body, -1n, "atomic.wait32 timeout");
  expectAtomic(body, 0x01, "memory.atomic.wait32");
  expectByte(body, 0x1a, "drop wait result");
  expectByte(body, 0x0b, "end drop block");

  const droppedData: number[] = [];
  while (body.peek() === 0xfc) {
    body.byte();
    if (body.u32() !== 9) body.fail("LLD memory initializer suffix must contain only data.drop");
    droppedData.push(body.u32());
  }
  if (
    droppedData.length !== passiveSegments.length ||
    droppedData.some((index, offset) => index !== passiveSegments[offset])
  )
    body.fail(
      "LLD initializer does not unconditionally drop every passive data segment exactly once",
    );
  if (initializedRanges.some((range) => range.begin < flagOffset + 4n && flagOffset < range.end))
    body.fail("LLD memory initializer overlaps its shared-memory guard word");
  expectByte(body, 0x0b, "final function end");
  body.expectDone("LLD memory initializer body");

  const flagExport = exports.get("__wasm_init_memory_flag");
  if (flagExport) {
    if (flagExport.kind !== 3) body.fail("LLD memory flag export is not a global");
    const flagDefinition = readGlobalDefinitions(sections, globalImports.length).find(
      (global) => global.index === flagExport.index,
    );
    if (
      !flagDefinition ||
      flagDefinition.type !== pointerType ||
      flagDefinition.mutable ||
      flagDefinition.initializer?.opcode !== (address === "i64" ? 0x42 : 0x41) ||
      pointerValue(flagDefinition.initializer.value, address) !== flagOffset
    )
      body.fail("LLD memory flag export does not match the start function");
  }

  return new Set(droppedData);
}

function transformData(payload: Reader, droppedPassiveData: ReadonlySet<number>) {
  const countStart = payload.offset;
  const count = payload.u32();
  // Preserve the original count and segment indices while rewriting only
  // segments whose runtime state is proven dropped.
  const output: Uint8Array<ArrayBuffer>[] = [payloadBytes(payload, countStart)];
  let transformed = false;

  for (let index = 0; index < count; index++) {
    const segmentStart = payload.offset;
    const flags = payload.u32();
    if (flags === 1) {
      const byteLength = payload.u32();
      payload.bytes(byteLength);
      if (droppedPassiveData.has(index)) {
        output.push(encodeU32(1), encodeU32(0));
        transformed = true;
      } else {
        output.push(payloadBytes(payload, segmentStart));
      }
      continue;
    }
    if (flags !== 0 && flags !== 2) payload.fail(`unsupported data segment flags ${flags}`);
    if (flags === 2 && payload.u32() !== 0)
      payload.fail("active data segment must target memory index 0");

    skipDataOffsetExpression(payload);
    const byteLength = payload.u32();
    // An active segment has already become unavailable after the original
    // instance initialization. Keep its index but do not resurrect its bytes.
    payload.bytes(byteLength);
    output.push(encodeU32(1), encodeU32(0));
    transformed = true;
  }
  payload.expectDone("data section");
  return { payload: transformed ? concatenate(output) : undefined, count };
}

type PublicationTableImage = {
  readonly tableIndex: number;
  readonly tableSize: number;
  readonly tableBaseGlobalIndex: number;
};

function publicationTableImage(source: Uint8Array<ArrayBuffer>): PublicationTableImage {
  const imports = read_wasm_dynamic_imports(source);
  const tables = imports.filter((entry) => entry.kind === "table");
  const canonicalIndex = tables.findIndex(
    (entry) => entry.module === "env" && entry.name === "__indirect_function_table",
  );
  const table = tables[canonicalIndex];
  if (canonicalIndex !== 0 || !table || table.kind !== "table")
    throw new DylinkWorkerModuleError(
      "publication element targets require canonical table zero",
      source.length,
    );

  let globalIndex = 0;
  const tableBaseGlobals: number[] = [];
  for (const entry of imports) {
    if (entry.kind !== "global") continue;
    if (
      entry.module === "env" &&
      (entry.name === "__table_base" || entry.name === "__table_base32") &&
      entry.value === table.address &&
      !entry.mutable
    )
      tableBaseGlobals.push(globalIndex);
    globalIndex++;
  }
  if (tableBaseGlobals.length !== 1)
    throw new DylinkWorkerModuleError(
      "publication element target needs one immutable canonical table base",
      source.length,
    );

  let metadata: ReturnType<typeof read_wasm_dylink>;
  try {
    metadata = read_wasm_dylink(new WebAssembly.Module(source));
  } catch (error) {
    if (error instanceof WebAssembly.CompileError) throw error;
    throw new DylinkWorkerModuleError(
      "publication element source has invalid dylink metadata",
      source.length,
    );
  }
  if (!metadata || metadata.unknownSubsections.length)
    throw new DylinkWorkerModuleError(
      "publication elements require recognized dylink.0 metadata",
      source.length,
    );
  return {
    tableIndex: canonicalIndex,
    tableSize: metadata.tableSize,
    tableBaseGlobalIndex: tableBaseGlobals[0]!,
  };
}

function skipElementInitExpression(reader: Reader) {
  const offset = reader.offset;
  try {
    skipGlobalInitializer(reader);
  } catch (error) {
    if (error instanceof DylinkWorkerModuleError)
      throw new DylinkWorkerModuleError(`invalid element initializer: ${error.message}`, offset);
    throw error;
  }
}

function readElementFunctionIndices(reader: Reader) {
  const count = reader.u32();
  for (let index = 0; index < count; index++) reader.u32();
  return count;
}

function readElementExpressions(reader: Reader) {
  const count = reader.u32();
  for (let index = 0; index < count; index++) skipElementInitExpression(reader);
  return count;
}

function skipActiveElementOffset(reader: Reader, image: PublicationTableImage) {
  if (reader.byte() !== 0x23)
    reader.fail("publication element offset must be global.get __table_base");
  if (reader.u32() !== image.tableBaseGlobalIndex)
    reader.fail("publication element offset does not use the canonical table base");
  if (reader.byte() !== 0x0b)
    reader.fail("publication element offset expression is not a single global.get");
}

function transformElementsForPublication(payload: Reader, getImage: () => PublicationTableImage) {
  const countStart = payload.offset;
  const count = payload.u32();
  const output: Uint8Array<ArrayBuffer>[] = [payloadBytes(payload, countStart)];
  let transformed = false;
  for (let index = 0; index < count; index++) {
    const segmentStart = payload.offset;
    const flags = payload.u32();
    let active = false;
    let newFlags = flags;
    let image: PublicationTableImage | undefined;
    if (flags === 0 || flags === 2 || flags === 4 || flags === 6) {
      active = true;
      image = getImage();
      if (flags === 2 || flags === 6) {
        if (payload.u32() !== image.tableIndex)
          payload.fail("publication element segment targets a noncanonical table");
      }
      skipActiveElementOffset(payload, image);
      newFlags = flags === 0 || flags === 2 ? 3 : 7;
    } else if (flags < 0 || flags > 7) {
      payload.fail(`unsupported element segment flags ${flags}`);
    }

    const typeStart = payload.offset;
    let elementCount: number;
    if (flags <= 3) {
      if (flags !== 0 && payload.byte() !== 0)
        payload.fail("unsupported function-index element kind");
      if (active && flags === 0) output.push(encodeU32(newFlags), new Uint8Array([0]));
      else if (active) output.push(encodeU32(newFlags));
      elementCount = readElementFunctionIndices(payload);
    } else {
      let referenceType = 0x70;
      if (flags !== 4) referenceType = skipValueType(payload);
      if (active && referenceType !== 0x70)
        payload.fail("publication element segment does not match the canonical funcref table");
      if (active) {
        output.push(encodeU32(newFlags));
        // Flag 4 has an implicit funcref type; flag 6 already carries it.
        if (flags === 4) output.push(new Uint8Array([referenceType]));
      }
      elementCount = readElementExpressions(payload);
    }

    if (active) {
      if (elementCount > image!.tableSize)
        payload.fail("publication element segment exceeds its reserved table range");
      output.push(payloadBytes(payload, typeStart));
      transformed = true;
    } else {
      output.push(payloadBytes(payload, segmentStart));
    }
  }
  payload.expectDone("element section");
  return transformed ? concatenate(output) : undefined;
}

function payloadBytes(reader: Reader, start: number) {
  // Copy a source range so rewritten sections do not alias caller-owned bytes.
  return reader.slice(start, reader.offset);
}

const sectionRanks = new Map([
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [13, 6], // exception tag section
  [6, 7],
  [7, 8],
  [8, 9],
  [9, 10],
  [12, 11], // data count precedes code despite its numeric section id
  [10, 12],
  [11, 13],
]);

/**
 * Prepare the immutable main module for a fresh Worker instance.
 *
 * Start is removed and active data segments become empty passive placeholders:
 * this preserves their data indices without making already-consumed active
 * payloads available to memory.init again. Existing passive segments retain
 * their payloads unless a recognized LLD memory initializer unconditionally
 * dropped them, in which case they become empty passive placeholders too.
 * By default, element segments and all other sections remain byte-for-byte
 * intact. Publication mode additionally converts active canonical-table
 * elements to declarative segments. This preserves their ref.func declarations
 * and dropped state while leaving table writes for the commit barrier.
 * Full snapshots and incremental publications both carry original raw bytes;
 * each receiving Worker derives this replay image locally instead of trusting
 * a separately supplied transformed copy.
 *
 * Runtime data.drop state outside the recognized LLD initializer is not
 * recovered. Callers must constrain this profile accordingly.
 */
export function prepare_dylink_worker_module(
  source: Uint8Array<ArrayBuffer>,
  address?: "i32" | "i64",
  options: { deferTableWrites?: boolean } = {},
): Uint8Array<ArrayBuffer> {
  if (options.deferTableWrites && !address)
    throw new DylinkWorkerModuleError(
      "publication element rewriting requires an address ABI",
      source.length,
    );
  const emptyTlsScaffold = address
    ? inspect_dylink_worker_empty_tls_scaffold(source, address)
    : null;
  const hasStart = readCoreSections(source).has(8);
  const hasPassiveData = has_dylink_worker_passive_data(source);
  if (address && hasPassiveData && !hasStart)
    throw new DylinkWorkerModuleError(
      "passive data state has no recognized start initializer",
      source.length,
    );
  const droppedPassiveData =
    address && hasStart && hasPassiveData
      ? (inspect_dylink_worker_memory_initializer(source, address) ?? new Set<number>())
      : new Set<number>();
  const reader = new Reader(source);
  for (const expected of [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
    if (reader.byte() !== expected) reader.fail("invalid WebAssembly header");

  const output: Uint8Array<ArrayBuffer>[] = [source.slice(0, 8)];
  const seen = new Set<number>();
  let lastRank = 0;
  let dataCount: number | undefined;
  let actualDataCount: number | undefined;
  let tableImage: PublicationTableImage | undefined;
  const getPublicationTableImage = () => (tableImage ??= publicationTableImage(source));

  while (!reader.done) {
    const sectionStart = reader.offset;
    const id = reader.byte();
    const payload = reader.section();
    const sectionEnd = reader.offset;

    if (id === 0) {
      payload.text();
      output.push(source.slice(sectionStart, sectionEnd));
      continue;
    }

    const rank = sectionRanks.get(id);
    if (rank === undefined)
      throw new DylinkWorkerModuleError(`unsupported core section id ${id}`, payload.offset);
    if (seen.has(id)) payload.fail(`duplicate core section id ${id}`);
    if (rank <= lastRank) payload.fail(`core section id ${id} is out of order`);
    seen.add(id);
    lastRank = rank;

    switch (id) {
      case 6:
        validateGlobals(
          payload,
          emptyTlsScaffold?.importedGlobals ?? 0,
          emptyTlsScaffold?.baseGlobalIndex,
        );
        break;
      case 8:
        validateStart(payload);
        // Never execute the process start function in a reconstructed Worker.
        continue;
      case 11: {
        const result = transformData(payload, droppedPassiveData);
        actualDataCount = result.count;
        output.push(
          result.payload
            ? encodeSection(id, result.payload)
            : source.slice(sectionStart, sectionEnd),
        );
        continue;
      }
      case 9:
        if (options.deferTableWrites) {
          const transformed = transformElementsForPublication(payload, getPublicationTableImage);
          output.push(
            transformed ? encodeSection(id, transformed) : source.slice(sectionStart, sectionEnd),
          );
          continue;
        }
        payload.bytes(payload.remaining());
        payload.expectDone("element section");
        break;
      case 12:
        dataCount = payload.u32();
        payload.expectDone("data count section");
        break;
      case 13:
        validateTags(payload);
        break;
      default:
        // Sections not relevant to this rewrite retain their original indices and bytes.
        payload.bytes(payload.remaining());
        payload.expectDone("core section");
        break;
    }
    output.push(source.slice(sectionStart, sectionEnd));
  }

  if (dataCount !== undefined && dataCount !== (actualDataCount ?? 0))
    throw new DylinkWorkerModuleError("data count does not match the data section", source.length);

  return concatenate(output);
}
