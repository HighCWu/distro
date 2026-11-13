// SPDX-License-Identifier: MIT

import { prepare_dylink_call_metadata } from "./dylink_call_metadata.ts";
import {
  DylinkWorkerModuleError,
  has_dylink_worker_passive_data,
  inspect_dylink_worker_empty_tls_scaffold,
  inspect_dylink_worker_memory_initializer,
  prepare_dylink_worker_module,
  type DylinkWorkerEmptyTlsScaffold,
} from "./dylink_worker_module.ts";
import {
  WasmParseError,
  prepare_wasm_dynamic_tail_calls,
  read_wasm_dynamic_imports,
  read_wasm_dylink,
  read_wasm_memories,
} from "./wasm_binary.ts";

export type DylinkWorkerModuleKey = "main" | string;
export type DylinkWorkerFunctionSlot = readonly [exportAlias: string, slot: bigint];
export type DylinkWorkerFunctionSlots = readonly DylinkWorkerFunctionSlot[];
export type DylinkWorkerSymbol = {
  moduleKey: DylinkWorkerModuleKey;
  exportAlias: string;
  kind: "function" | "global" | "tag";
  signature?: string;
  address?: bigint;
};
export type DylinkWorkerSymbols = readonly (readonly [name: string, symbol: DylinkWorkerSymbol])[];
export type DylinkWorkerPlacement = {
  base: bigint;
  tableBase: bigint;
};
export type DylinkWorkerTableSlot = {
  moduleKey: DylinkWorkerModuleKey;
  exportAlias: string;
};

export interface DylinkWorkerFile {
  key: string;
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  pin: number;
  handle?: bigint;
  dependencies: readonly (readonly [name: string, key: string])[];
}

export interface DylinkWorkerGroup {
  /** Groups are stored in creation order and use their zero-based index as ID. */
  id: number;
  root: string;
  handle: bigint;
  /** The linker's original DFS postorder, including dependencies. */
  order: readonly string[];
  /** Unresolved lazy imports retained by this group, as name/signature pairs. */
  lazyFunctions: readonly (readonly [name: string, signature: string])[];
  placements: readonly (readonly [key: string, placement: DylinkWorkerPlacement])[];
  /** Raw module exports only; private call aliases belong in tableSlots. */
  functionSlots: readonly (readonly [key: string, slots: DylinkWorkerFunctionSlots])[];
  /** The exact process symbol scope visible when this group was linked. */
  externalSymbols: DylinkWorkerSymbols;
}

export interface DylinkWorkerObjectGroup {
  groupId: number;
  root: string;
  handle: bigint;
}

export interface DylinkWorkerSnapshot {
  version: 1;
  address: "i32" | "i64";
  tableAddress: "i32" | "i64";
  main: {
    handle: bigint;
    lastMap: bigint;
    cursor: bigint;
    tableLength: number;
    functionSlots: DylinkWorkerFunctionSlots;
    /** One entry per table element; null preserves an empty slot. */
    tableSlots: readonly (DylinkWorkerTableSlot | null)[];
    addressNames: readonly (readonly [name: string, address: bigint])[];
  };
  files: readonly DylinkWorkerFile[];
  groups: readonly DylinkWorkerGroup[];
  objectGroups: readonly (readonly [key: string, object: DylinkWorkerObjectGroup])[];
  aliases: readonly (readonly [alias: string, key: string])[];
  globalOrder: readonly string[];
  owners: readonly (readonly [name: string, owner: number])[];
  ownerNames: readonly (readonly [owner: number, name: string])[];
  nextOwner: number;
  symbols: DylinkWorkerSymbols;
}

/** A clone-safe append-only graph delta, staged against one exact snapshot generation. */
export interface DylinkWorkerPublication {
  /** Publication wire schema version; independent of the process generation. */
  version: 1;
  processIdentity: string;
  baseGeneration: number;
  generation: number;
  address: "i32" | "i64";
  tableAddress: "i32" | "i64";
  base: {
    mainHandle: bigint;
    lastMap: bigint;
    cursor: bigint;
    tableLength: number;
    fileCount: number;
    groupCount: number;
    objectCount: number;
  };
  main: {
    handle: bigint;
    lastMap: bigint;
    cursor: bigint;
    tableLength: number;
    functionSlots: DylinkWorkerFunctionSlots;
    /** Absolute table indices which transition from empty to occupied. */
    tableSlots: readonly (readonly [index: number, slot: DylinkWorkerTableSlot])[];
    addressNames: readonly (readonly [name: string, address: bigint])[];
  };
  /** Only newly pinned modules; bytes are the original raw Wasm, never transformed replay bytes. */
  files: readonly DylinkWorkerFile[];
  /** New complete groups in creation order; dependencies may refer to old files. */
  groups: readonly DylinkWorkerGroup[];
  /** Newly assigned canonical aliases for existing module records, if any. */
  groupFunctionSlots: readonly (readonly [
    groupId: number,
    functionSlots: DylinkWorkerGroup["functionSlots"],
  ])[];
  objectGroups: readonly (readonly [key: string, object: DylinkWorkerObjectGroup])[];
  aliases: readonly (readonly [alias: string, key: string])[];
  /** Newly appended global scope entries, in their original lookup order. */
  globalOrder: readonly string[];
  owners: readonly (readonly [name: string, owner: number])[];
  ownerNames: readonly (readonly [owner: number, name: string])[];
  nextOwner: number;
  /** Newly published names only; each new group's externalSymbols freezes load-time binding. */
  symbols: DylinkWorkerSymbols;
}

/** Delta fields supplied from the just-committed group; old graph state is not recopied. */
export type DylinkWorkerPublicationDraft = Pick<
  DylinkWorkerPublication,
  | "main"
  | "files"
  | "groups"
  | "groupFunctionSlots"
  | "objectGroups"
  | "aliases"
  | "globalOrder"
  | "owners"
  | "ownerNames"
  | "nextOwner"
  | "symbols"
>;

export class DylinkWorkerSnapshotError extends Error {
  readonly code: "ENOMEM" | "EOPNOTSUPP" | "EINVAL";

  constructor(code: "ENOMEM" | "EOPNOTSUPP" | "EINVAL", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DylinkWorkerSnapshotError";
    this.code = code;
  }
}

function fail(message: string, cause?: unknown): never {
  throw new DylinkWorkerSnapshotError("EINVAL", message, { cause });
}

function unsupported(message: string, cause?: unknown): never {
  throw new DylinkWorkerSnapshotError("EOPNOTSUPP", message, { cause });
}

function noMemory(message: string, cause?: unknown): never {
  throw new DylinkWorkerSnapshotError("ENOMEM", message, { cause });
}

// Publication snapshots are private immutable generations. Reusing their
// validated entries is safe because each generation freezes its object graph;
// Uint8Array module bytes are detached copies and remain read-only by contract.
const trustedSnapshots = new WeakSet<object>();
const frozenPublicationObjects = new WeakSet<object>();

function freezePublicationGraph(value: unknown): void {
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) return;
  if (frozenPublicationObjects.has(value)) return;
  frozenPublicationObjects.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) freezePublicationGraph(descriptor.value);
  }
  Object.freeze(value);
}

function retainValidatedSnapshot(snapshot: DylinkWorkerSnapshot): DylinkWorkerSnapshot {
  freezePublicationGraph(snapshot);
  trustedSnapshots.add(snapshot);
  return snapshot;
}

function requireValidatedSnapshot(snapshot: DylinkWorkerSnapshot, label: string): void {
  if (!trustedSnapshots.has(snapshot))
    fail(`${label} must be a privately prepared or applied Worker snapshot`);
}

function plainRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(`${label} has a non-cloneable prototype`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.includes(key)))
    fail(`${label} has unsupported fields`);
  const object = value as Record<string, unknown>;
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor))
      fail(`${label}.${key} is missing or is an accessor`);
  }
  for (const key of ownKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
    if (!("value" in descriptor)) fail(`${label}.${key} is an accessor`);
  }
  return object;
}

function arrayValue(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail(`${label} must be a plain array`);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
    )
  )
    fail(`${label} has unsupported array properties`);
  for (let index = 0; index < value.length; index++) {
    if (!(index in value)) fail(`${label} contains a sparse entry`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) fail(`${label} contains an accessor`);
  }
  return value;
}

function tuple(value: unknown, length: number, label: string): readonly unknown[] {
  const items = arrayValue(value, label);
  if (items.length !== length) fail(`${label} must have ${length} entries`);
  return items;
}

function text(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0"))
    fail(`${label} must be a valid string`);
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    fail(`${label} must be a safe integer in range`);
  return value as number;
}

function word(value: unknown, label: string, address: "i32" | "i64", allowLimit = false): bigint {
  if (typeof value !== "bigint" || value < 0n) fail(`${label} must be a nonnegative bigint`);
  const limit = 1n << BigInt(address === "i32" ? 32 : 64);
  if (allowLimit ? value > limit : value >= limit) fail(`${label} exceeds pointer width`);
  return value;
}

function cloneBytes(value: unknown, label: string, copy: boolean): Uint8Array<ArrayBuffer> {
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer))
    fail(`${label} must be an ArrayBuffer-backed Uint8Array`);
  if (!copy) return value as Uint8Array<ArrayBuffer>;
  try {
    return new Uint8Array(value);
  } catch (error) {
    if (error instanceof RangeError) noMemory(`${label} cannot be copied into a Worker snapshot`);
    throw error;
  }
}

function uniqueStringPairs(value: unknown, label: string): [string, string][] {
  const result: [string, string][] = [];
  const seen = new Set<string>();
  for (const [index, entry] of arrayValue(value, label).entries()) {
    const [firstValue, secondValue] = tuple(entry, 2, `${label}[${index}]`);
    const first = text(firstValue, `${label}[${index}][0]`);
    const second = text(secondValue, `${label}[${index}][1]`);
    if (seen.has(first)) fail(`${label} contains a duplicate key`);
    seen.add(first);
    result.push([first, second]);
  }
  return result;
}

function readU32(
  bytes: Uint8Array<ArrayBuffer>,
  cursor: { offset: number },
  end: number,
  label: string,
): number {
  let value = 0;
  for (let index = 0; index < 5; index++) {
    if (cursor.offset >= end) fail(`${label} is truncated`);
    const byte = bytes[cursor.offset++]!;
    const payload = byte & 0x7f;
    if (index === 4 && payload > 0x0f) fail(`${label} overflows u32`);
    value |= payload << (index * 7);
    if ((byte & 0x80) === 0) return value >>> 0;
  }
  return fail(`${label} LEB128 is too long`);
}

function skipLeb(
  bytes: Uint8Array<ArrayBuffer>,
  cursor: { offset: number },
  end: number,
  maxBytes: number,
  label: string,
) {
  for (let index = 0; index < maxBytes; index++) {
    if (cursor.offset >= end) fail(`${label} is truncated`);
    if ((bytes[cursor.offset++]! & 0x80) === 0) return;
  }
  fail(`${label} LEB128 is too long`);
}

function skipOffsetExpression(
  bytes: Uint8Array<ArrayBuffer>,
  cursor: { offset: number },
  end: number,
) {
  if (cursor.offset >= end) fail("Wasm offset expression is truncated");
  switch (bytes[cursor.offset++]!) {
    case 0x41:
      skipLeb(bytes, cursor, end, 5, "i32 constant");
      break;
    case 0x42:
      skipLeb(bytes, cursor, end, 10, "i64 constant");
      break;
    case 0x23:
      readU32(bytes, cursor, end, "global index");
      break;
    default:
      unsupported("Wasm offset expression is not supported by Worker replay");
  }
  if (cursor.offset >= end || bytes[cursor.offset++] !== 0x0b)
    fail("Wasm offset expression is not terminated");
}

function skipGlobalValueType(
  bytes: Uint8Array<ArrayBuffer>,
  cursor: { offset: number },
  end: number,
) {
  if (cursor.offset >= end) fail("Wasm global value type is truncated");
  const type = bytes[cursor.offset++]!;
  if (
    (type >= 0x7b && type <= 0x7f) ||
    type === 0x6f ||
    type === 0x70 ||
    (type >= 0x69 && type <= 0x74)
  )
    return;
  if (type === 0x63 || type === 0x64) {
    skipLeb(bytes, cursor, end, 5, "global heap type");
    return;
  }
  unsupported("Wasm global value type is not supported by Worker replay");
}

function skipGlobalInitializer(
  bytes: Uint8Array<ArrayBuffer>,
  cursor: { offset: number },
  end: number,
) {
  for (;;) {
    if (cursor.offset >= end) fail("Wasm global initializer is truncated");
    const opcode = bytes[cursor.offset++]!;
    switch (opcode) {
      case 0x0b:
        return;
      case 0x23:
      case 0xd2:
        readU32(bytes, cursor, end, "global initializer index");
        break;
      case 0x41:
        skipLeb(bytes, cursor, end, 5, "global i32 initializer");
        break;
      case 0x42:
        skipLeb(bytes, cursor, end, 10, "global i64 initializer");
        break;
      case 0x43:
        if (end - cursor.offset < 4) fail("global f32 initializer is truncated");
        cursor.offset += 4;
        break;
      case 0x44:
        if (end - cursor.offset < 8) fail("global f64 initializer is truncated");
        cursor.offset += 8;
        break;
      case 0xd0:
        skipLeb(bytes, cursor, end, 5, "global reference heap type");
        break;
      case 0xfd:
        if (readU32(bytes, cursor, end, "global SIMD initializer opcode") !== 12)
          unsupported("global initializer uses an unsupported SIMD instruction");
        if (end - cursor.offset < 16) fail("global v128 initializer is truncated");
        cursor.offset += 16;
        break;
      // Extended constant expressions can contain integer arithmetic. These
      // instructions have no immediate operands, so continue to the final end.
      default:
        if (
          (opcode >= 0x45 && opcode <= 0x5a) ||
          (opcode >= 0x67 && opcode <= 0x8a) ||
          (opcode >= 0xc0 && opcode <= 0xc4)
        )
          break;
        unsupported(`global initializer uses unsupported opcode 0x${opcode.toString(16)}`);
    }
  }
}

function workerDataState(
  bytes: Uint8Array<ArrayBuffer>,
  emptyTlsScaffold: DylinkWorkerEmptyTlsScaffold | null,
  droppedPassiveData: ReadonlySet<number>,
) {
  const cursor = { offset: 8 };
  let hasStart = false;
  let hasDefinedMutableGlobals = false;
  let hasPassiveData = false;
  let hasPassiveElements = false;
  let sectionData: { start: number; end: number } | undefined;
  let sectionGlobals: { start: number; end: number } | undefined;
  while (cursor.offset < bytes.length) {
    const id = bytes[cursor.offset++]!;
    const length = readU32(bytes, cursor, bytes.length, "Wasm section length");
    const start = cursor.offset;
    const end = start + length;
    if (end > bytes.length) fail("Wasm section extends past module bytes");
    if (id === 8) hasStart = true;
    if (id === 6) sectionGlobals = { start, end };
    if (id === 11) sectionData = { start, end };
    if (id === 9) {
      const section = { offset: start };
      const count = readU32(bytes, section, end, "element segment count");
      for (let index = 0; index < count; index++) {
        const flags = readU32(bytes, section, end, "element segment flags");
        if (flags === 1 || flags === 5) {
          hasPassiveElements = true;
          break;
        }
        if (flags === 3 || flags === 7) {
          // Declarative segments are dropped by instantiation itself, so the
          // transformed Worker module recreates their already-dropped state.
          if (flags === 3) {
            if (section.offset >= end || bytes[section.offset++] !== 0)
              unsupported("declarative element kind is not supported");
            const entries = readU32(bytes, section, end, "declarative element count");
            for (let entry = 0; entry < entries; entry++)
              readU32(bytes, section, end, "declarative element index");
          } else {
            if (section.offset >= end) fail("declarative element type is truncated");
            const referenceType = bytes[section.offset++]!;
            if (referenceType === 0x63 || referenceType === 0x64)
              skipLeb(bytes, section, end, 5, "declarative element heap type");
            const entries = readU32(bytes, section, end, "declarative element expression count");
            for (let entry = 0; entry < entries; entry++) {
              if (section.offset >= end) fail("declarative element expression is truncated");
              const opcode = bytes[section.offset++]!;
              if (opcode === 0xd0) skipLeb(bytes, section, end, 5, "declarative heap type");
              else if (opcode === 0xd2 || opcode === 0x23)
                readU32(bytes, section, end, "declarative reference index");
              else unsupported("declarative element initializer is not supported");
              if (section.offset >= end || bytes[section.offset++] !== 0x0b)
                fail("declarative element initializer is not terminated");
            }
          }
          continue;
        }
        if (flags === 0 || flags === 4) {
          skipOffsetExpression(bytes, section, end);
        } else if (flags === 2 || flags === 6) {
          readU32(bytes, section, end, "element table index");
          skipOffsetExpression(bytes, section, end);
        } else unsupported("element segment flags are not supported by Worker replay");

        if (flags === 0 || flags === 2) {
          // Active table-zero segments (flags 0) use the legacy function-index
          // vector directly. The elemkind byte is present only for explicit
          // table-index segments (flags 2).
          if (flags === 2 && (section.offset >= end || bytes[section.offset++] !== 0))
            unsupported("element kind is not supported by Worker replay");
          const entries = readU32(bytes, section, end, "element function count");
          for (let entry = 0; entry < entries; entry++)
            readU32(bytes, section, end, "element function index");
        } else {
          if (flags === 6) {
            if (section.offset >= end) fail("element reference type is truncated");
            const referenceType = bytes[section.offset++]!;
            if (referenceType === 0x63 || referenceType === 0x64)
              skipLeb(bytes, section, end, 5, "element heap type");
          }
          const entries = readU32(bytes, section, end, "element expression count");
          for (let entry = 0; entry < entries; entry++) {
            if (section.offset >= end) fail("element expression is truncated");
            const opcode = bytes[section.offset++]!;
            if (opcode === 0xd0) skipLeb(bytes, section, end, 5, "element heap type");
            else if (opcode === 0xd2 || opcode === 0x23)
              readU32(bytes, section, end, "element reference index");
            else unsupported("element initializer is not supported by Worker replay");
            if (section.offset >= end || bytes[section.offset++] !== 0x0b)
              fail("element initializer is not terminated");
          }
        }
      }
    }
    cursor.offset = end;
  }

  if (sectionGlobals) {
    const section = { offset: sectionGlobals.start };
    const count = readU32(bytes, section, sectionGlobals.end, "global count");
    for (let index = 0; index < count; index++) {
      skipGlobalValueType(bytes, section, sectionGlobals.end);
      if (section.offset >= sectionGlobals.end) fail("Wasm global mutability is truncated");
      const mutable = bytes[section.offset++]!;
      if (mutable > 1) fail("Wasm global mutability is invalid");
      const globalIndex = (emptyTlsScaffold?.importedGlobals ?? 0) + index;
      if (mutable !== 0 && globalIndex !== emptyTlsScaffold?.baseGlobalIndex) {
        hasDefinedMutableGlobals = true;
      }
      skipGlobalInitializer(bytes, section, sectionGlobals.end);
    }
  }

  if (sectionData) {
    const section = { offset: sectionData.start };
    const count = readU32(bytes, section, sectionData.end, "data segment count");
    for (let index = 0; index < count; index++) {
      const flags = readU32(bytes, section, sectionData.end, "data segment flags");
      if (flags === 1) {
        if (!droppedPassiveData.has(index)) hasPassiveData = true;
      } else {
        if (flags === 2) readU32(bytes, section, sectionData.end, "data memory index");
        else if (flags !== 0) unsupported("data segment flags are not supported by Worker replay");
        skipOffsetExpression(bytes, section, sectionData.end);
      }
      const length = readU32(bytes, section, sectionData.end, "data segment length");
      if (length > sectionData.end - section.offset) fail("data segment extends past section");
      section.offset += length;
    }
    if (section.offset !== sectionData.end) fail("trailing bytes in data section");
  }

  return { hasStart, hasDefinedMutableGlobals, hasPassiveData, hasPassiveElements };
}

function validateReplayableModule(
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  address: "i32" | "i64",
) {
  if (bytes.length < 8) fail(`dynamic module ${key} is truncated`);
  let original: WebAssembly.Module;
  let metadata;
  let replayBytes: Uint8Array<ArrayBuffer>;
  let replayModule: WebAssembly.Module;
  let privateAliases: ReadonlyMap<string, { signature: string; imported: boolean }>;
  try {
    original = new WebAssembly.Module(bytes);
    metadata = read_wasm_dylink(original);
    if (!metadata) fail(`dynamic module ${key} has no dylink.0 metadata`);
    if (metadata.unknownSubsections.length)
      unsupported(`dynamic module ${key} uses an unknown dylink subsection`);
    if (metadata.target !== undefined && metadata.target !== `wasm${address === "i32" ? 32 : 64}`)
      unsupported(`dynamic module ${key} targets the wrong pointer width`);
    if (
      metadata.imports.some((symbol) => symbol.flags & 0x100) ||
      metadata.exports.some((symbol) => symbol.flags & 0x100)
    )
      unsupported(`dynamic module ${key} uses unsupported TLS`);
    const emptyTlsScaffold = inspect_dylink_worker_empty_tls_scaffold(bytes, address, original);
    const droppedPassiveData = has_dylink_worker_passive_data(bytes)
      ? (inspect_dylink_worker_memory_initializer(bytes, address, original) ?? new Set<number>())
      : new Set<number>();
    if (read_wasm_memories(bytes).definitions.length)
      unsupported(`dynamic module ${key} defines private memory`);

    const state = workerDataState(bytes, emptyTlsScaffold, droppedPassiveData);
    if (state.hasDefinedMutableGlobals)
      unsupported(`dynamic module ${key} defines mutable globals whose values are not captured`);
    if (state.hasPassiveData || state.hasPassiveElements)
      unsupported(
        `dynamic module ${key} has passive segment state that Worker replay cannot restore`,
      );
    const dynamicImports = read_wasm_dynamic_imports(bytes);
    if (
      state.hasStart &&
      dynamicImports.some(
        (entry) =>
          entry.kind === "global" &&
          entry.mutable &&
          (entry.module === "GOT.mem" || entry.module === "GOT.func"),
      )
    )
      unsupported(`dynamic module ${key} start may alter unsnapshotted GOT globals`);

    const tail = prepare_wasm_dynamic_tail_calls(bytes);
    replayBytes = prepare_dylink_worker_module(tail.bytes, address);
    replayModule = new WebAssembly.Module(replayBytes);
    privateAliases = prepare_dylink_call_metadata(replayBytes).functions;
  } catch (error) {
    if (error instanceof DylinkWorkerSnapshotError) throw error;
    if (error instanceof DylinkWorkerModuleError)
      unsupported(`dynamic module ${key} cannot be reconstructed: ${error.message}`, error);
    if (error instanceof RangeError)
      noMemory(`dynamic module ${key} cannot be reconstructed: ${error.message}`, error);
    if (
      error instanceof WasmParseError ||
      error instanceof WebAssembly.CompileError ||
      error instanceof TypeError
    )
      fail(`dynamic module ${key} is invalid: ${error.message}`, error);
    unsupported(
      `dynamic module ${key} cannot be reconstructed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  const replayExports = new Map(
    WebAssembly.Module.exports(replayModule!).map((entry) => [entry.name, entry.kind]),
  );
  const originalExports = new Map(
    WebAssembly.Module.exports(original!).map((entry) => [entry.name, entry.kind]),
  );
  return { metadata: metadata!, replayExports, originalExports, privateAliases: privateAliases! };
}

/** Validate a freshly loaded module before its owner allocates or instantiates
 * it when that module must be replayed into existing Workers. */
export function validate_dylink_worker_replayable_module(
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
  address: "i32" | "i64",
): void {
  validateReplayableModule(key, bytes, address);
}

function sanitizeSymbols(
  value: unknown,
  label: string,
  address: "i32" | "i64",
  fileKeys: ReadonlySet<string>,
  copy: boolean,
) {
  const result: [string, DylinkWorkerSymbol][] = [];
  const names = new Set<string>();
  for (const [index, entry] of arrayValue(value, label).entries()) {
    const [nameValue, symbolValue] = tuple(entry, 2, `${label}[${index}]`);
    const name = text(nameValue, `${label}[${index}][0]`);
    if (names.has(name)) fail(`${label} contains a duplicate symbol`);
    names.add(name);
    const symbol = plainRecord(
      symbolValue,
      ["moduleKey", "exportAlias", "kind", "signature", "address"],
      ["moduleKey", "exportAlias", "kind"],
      `${label}[${index}][1]`,
    );
    const moduleKey = text(symbol.moduleKey, `${label}[${index}].moduleKey`);
    if (moduleKey !== "main" && !fileKeys.has(moduleKey))
      fail(`${label} references an unknown module`);
    const exportAlias = text(symbol.exportAlias, `${label}[${index}].exportAlias`);
    if (symbol.kind !== "function" && symbol.kind !== "global" && symbol.kind !== "tag")
      fail(`${label}[${index}].kind is invalid`);
    const signature =
      symbol.signature === undefined
        ? undefined
        : text(symbol.signature, `${label}[${index}].signature`, true);
    const addressValue =
      symbol.address === undefined
        ? undefined
        : word(symbol.address, `${label}[${index}].address`, address);
    result.push([
      name,
      {
        moduleKey,
        exportAlias,
        kind: symbol.kind,
        ...(signature === undefined ? {} : { signature }),
        ...(addressValue === undefined ? {} : { address: addressValue }),
      },
    ]);
  }
  return copy ? result : (value as DylinkWorkerSymbols);
}

function sanitizeWorkerSnapshot(value: unknown, copy: boolean): DylinkWorkerSnapshot {
  const top = plainRecord(
    value,
    [
      "version",
      "address",
      "tableAddress",
      "main",
      "files",
      "groups",
      "objectGroups",
      "aliases",
      "globalOrder",
      "owners",
      "ownerNames",
      "nextOwner",
      "symbols",
    ],
    [
      "version",
      "address",
      "tableAddress",
      "main",
      "files",
      "groups",
      "objectGroups",
      "aliases",
      "globalOrder",
      "owners",
      "ownerNames",
      "nextOwner",
      "symbols",
    ],
    "snapshot",
  );
  if (top.version !== 1) fail("unsupported dynamic Worker snapshot version");
  if (top.address !== "i32" && top.address !== "i64") fail("snapshot address width is invalid");
  if (top.tableAddress !== "i32" && top.tableAddress !== "i64")
    fail("snapshot table address width is invalid");
  const address = top.address;
  const tableAddress = top.tableAddress;

  const files: DylinkWorkerFile[] = [];
  const filesByKey = new Map<string, DylinkWorkerFile>();
  const fileMetadata = new Map<string, ReturnType<typeof validateReplayableModule>>();
  const pins = new Set<number>();
  for (const [index, item] of arrayValue(top.files, "snapshot.files").entries()) {
    const file = plainRecord(
      item,
      ["key", "path", "bytes", "pin", "handle", "dependencies"],
      ["key", "path", "bytes", "pin", "dependencies"],
      `snapshot.files[${index}]`,
    );
    const key = text(file.key, `snapshot.files[${index}].key`);
    if (key === "main" || filesByKey.has(key))
      fail("snapshot contains a duplicate or reserved file key");
    const path = text(file.path, `snapshot.files[${index}].path`);
    const bytes = cloneBytes(file.bytes, `snapshot.files[${index}].bytes`, copy);
    const pin = integer(file.pin, `snapshot.files[${index}].pin`, 1, 0xffff_ffff);
    if (pins.has(pin)) fail("snapshot contains duplicate file pins");
    pins.add(pin);
    const handle =
      file.handle === undefined
        ? undefined
        : word(file.handle, `snapshot.files[${index}].handle`, address);
    const dependencies = uniqueStringPairs(
      file.dependencies,
      `snapshot.files[${index}].dependencies`,
    );
    const sanitized: DylinkWorkerFile = {
      key,
      path,
      bytes,
      pin,
      ...(handle === undefined ? {} : { handle }),
      dependencies,
    };
    files.push(sanitized);
    filesByKey.set(key, sanitized);
    fileMetadata.set(key, validateReplayableModule(key, bytes, address));
  }
  const fileKeys = new Set(filesByKey.keys());
  for (const file of files) {
    const dependencyNames = new Set(file.dependencies.map(([name]) => name));
    const metadata = fileMetadata.get(file.key)!.metadata;
    for (const dependency of metadata.needed) {
      if (!dependencyNames.has(dependency))
        fail(`file ${file.key} is missing dependency resolution ${dependency}`);
    }
    for (const [, key] of file.dependencies)
      if (!fileKeys.has(key)) fail(`file ${file.key} references an unknown dependency`);
  }

  const main = plainRecord(
    top.main,
    ["handle", "lastMap", "cursor", "tableLength", "functionSlots", "tableSlots", "addressNames"],
    ["handle", "lastMap", "cursor", "tableLength", "functionSlots", "tableSlots", "addressNames"],
    "snapshot.main",
  );
  const mainHandle = word(main.handle, "snapshot.main.handle", address);
  const lastMap = word(main.lastMap, "snapshot.main.lastMap", address);
  const cursor = word(main.cursor, "snapshot.main.cursor", tableAddress, true);
  const tableLength = integer(main.tableLength, "snapshot.main.tableLength", 0, 0xffff_ffff);
  if (cursor > BigInt(tableLength)) fail("snapshot table cursor exceeds table length");
  const functionSlots: [string, bigint][] = [];
  const mainFunctions = new Set<string>();
  for (const [index, entry] of arrayValue(
    main.functionSlots,
    "snapshot.main.functionSlots",
  ).entries()) {
    const [nameValue, slotValue] = tuple(entry, 2, `snapshot.main.functionSlots[${index}]`);
    const name = text(nameValue, `snapshot.main.functionSlots[${index}][0]`);
    const slot = word(slotValue, `snapshot.main.functionSlots[${index}][1]`, tableAddress);
    if (BigInt(tableLength) <= slot) fail("main function slot exceeds table length");
    if (mainFunctions.has(name)) fail("snapshot has duplicate main function aliases");
    mainFunctions.add(name);
    functionSlots.push([name, slot]);
  }

  const groups: DylinkWorkerGroup[] = [];
  const groupRoots = new Set<string>();
  const groupHandles = new Set<bigint>();
  const placementsByKey = new Map<string, DylinkWorkerPlacement>();
  const allFunctionAliases = new Map<string, Set<string>>();
  for (const [index, item] of arrayValue(top.groups, "snapshot.groups").entries()) {
    const group = plainRecord(
      item,
      [
        "id",
        "root",
        "handle",
        "order",
        "lazyFunctions",
        "placements",
        "functionSlots",
        "externalSymbols",
      ],
      [
        "id",
        "root",
        "handle",
        "order",
        "lazyFunctions",
        "placements",
        "functionSlots",
        "externalSymbols",
      ],
      `snapshot.groups[${index}]`,
    );
    const id = integer(group.id, `snapshot.groups[${index}].id`, 0, 0xffff_ffff);
    if (id !== index) fail("snapshot group IDs must match creation order");
    const root = text(group.root, `snapshot.groups[${index}].root`);
    if (!fileKeys.has(root) || groupRoots.has(root))
      fail("snapshot group root is missing or duplicated");
    groupRoots.add(root);
    const handle = word(group.handle, `snapshot.groups[${index}].handle`, address);
    if (handle === 0n || groupHandles.has(handle))
      fail("snapshot group handle is zero or duplicated");
    groupHandles.add(handle);
    const order = arrayValue(group.order, `snapshot.groups[${index}].order`).map(
      (key, orderIndex) => text(key, `snapshot.groups[${index}].order[${orderIndex}]`),
    );
    if (new Set(order).size !== order.length || !order.includes(root))
      fail("snapshot group order is invalid");
    if (order.some((key) => !fileKeys.has(key)))
      fail("snapshot group order references an unknown file");
    const lazyFunctions: [string, string][] = [];
    for (const [lazyIndex, entry] of arrayValue(
      group.lazyFunctions,
      `snapshot.groups[${index}].lazyFunctions`,
    ).entries()) {
      const [nameValue, signatureValue] = tuple(
        entry,
        2,
        `snapshot.groups[${index}].lazyFunctions[${lazyIndex}]`,
      );
      const name = text(nameValue, `snapshot.groups[${index}].lazyFunctions[${lazyIndex}][0]`);
      const signature = text(
        signatureValue,
        `snapshot.groups[${index}].lazyFunctions[${lazyIndex}][1]`,
        true,
      );
      lazyFunctions.push([name, signature]);
    }
    const placements: [string, DylinkWorkerPlacement][] = [];
    const groupPlacementKeys = new Set<string>();
    for (const [placementIndex, entry] of arrayValue(
      group.placements,
      `snapshot.groups[${index}].placements`,
    ).entries()) {
      const [keyValue, placementValue] = tuple(
        entry,
        2,
        `snapshot.groups[${index}].placements[${placementIndex}]`,
      );
      const key = text(keyValue, `snapshot.groups[${index}].placements[${placementIndex}][0]`);
      if (!order.includes(key) || groupPlacementKeys.has(key))
        fail("snapshot group placement key is invalid or duplicated");
      const placement = plainRecord(
        placementValue,
        ["base", "tableBase"],
        ["base", "tableBase"],
        `snapshot placement ${key}`,
      );
      const base = word(placement.base, `snapshot placement ${key}.base`, address);
      const tableBase = word(
        placement.tableBase,
        `snapshot placement ${key}.tableBase`,
        tableAddress,
      );
      const metadata = fileMetadata.get(key)!.metadata;
      const memoryAlignment = metadata.memoryAlignment;
      const tableAlignment = metadata.tableAlignment;
      if (
        !Number.isInteger(metadata.memorySize) ||
        metadata.memorySize < 0 ||
        metadata.memorySize > 0xffff_ffff ||
        !Number.isInteger(memoryAlignment) ||
        memoryAlignment < 0 ||
        memoryAlignment >= (address === "i32" ? 32 : 64) ||
        !Number.isInteger(metadata.tableSize) ||
        metadata.tableSize < 0 ||
        metadata.tableSize > 0xffff_ffff ||
        !Number.isInteger(tableAlignment) ||
        tableAlignment < 0 ||
        tableAlignment >= (tableAddress === "i32" ? 32 : 64)
      )
        fail(`dynamic module ${key} has invalid placement metadata`);
      const memoryEnd = base + BigInt(metadata.memorySize);
      const tableEnd = tableBase + BigInt(metadata.tableSize);
      if (
        memoryEnd > 1n << BigInt(address === "i32" ? 32 : 64) ||
        tableEnd > 1n << BigInt(tableAddress === "i32" ? 32 : 64) ||
        base % (1n << BigInt(memoryAlignment)) !== 0n ||
        tableBase % (1n << BigInt(tableAlignment)) !== 0n ||
        tableEnd > BigInt(tableLength)
      )
        fail(`dynamic module ${key} placement overflows its address space or table`);
      const old = placementsByKey.get(key);
      if (old && (old.base !== base || old.tableBase !== tableBase))
        fail(`dynamic module ${key} has conflicting placements`);
      placementsByKey.set(key, { base, tableBase });
      groupPlacementKeys.add(key);
      placements.push([key, { base, tableBase }]);
    }
    if (groupPlacementKeys.size !== order.length)
      fail("snapshot group is missing module placements");

    const functionSlotGroups: [string, [string, bigint][]][] = [];
    const functionSlotKeys = new Set<string>();
    for (const [moduleIndex, entry] of arrayValue(
      group.functionSlots,
      `snapshot.groups[${index}].functionSlots`,
    ).entries()) {
      const [keyValue, slotsValue] = tuple(
        entry,
        2,
        `snapshot.groups[${index}].functionSlots[${moduleIndex}]`,
      );
      const key = text(keyValue, `snapshot.groups[${index}].functionSlots[${moduleIndex}][0]`);
      if (!order.includes(key) || functionSlotKeys.has(key))
        fail("snapshot function-slot module key is invalid or duplicated");
      const metadata = fileMetadata.get(key)!;
      const slots: [string, bigint][] = [];
      const aliases = new Set<string>();
      for (const [slotIndex, slotEntry] of arrayValue(
        slotsValue,
        `snapshot.groups[${index}].functionSlots.${key}`,
      ).entries()) {
        const [aliasValue, value] = tuple(
          slotEntry,
          2,
          `snapshot.groups[${index}].functionSlots.${key}[${slotIndex}]`,
        );
        const alias = text(
          aliasValue,
          `snapshot.groups[${index}].functionSlots.${key}[${slotIndex}][0]`,
        );
        const slot = word(
          value,
          `snapshot.groups[${index}].functionSlots.${key}[${slotIndex}][1]`,
          tableAddress,
        );
        if (BigInt(tableLength) <= slot)
          fail(`function slot for ${key}.${alias} exceeds table length`);
        if (metadata.originalExports.get(alias) !== "function")
          fail(`replay slot references a non-exported function ${key}.${alias}`);
        if (aliases.has(alias)) fail(`snapshot has duplicate function alias ${key}.${alias}`);
        aliases.add(alias);
        slots.push([alias, slot]);
      }
      functionSlotKeys.add(key);
      functionSlotGroups.push([key, slots]);
      allFunctionAliases.set(
        key,
        new Set([
          ...aliases,
          ...metadata.privateAliases.keys(),
          ...Array.from(metadata.originalExports)
            .filter(([, kind]) => kind === "function")
            .map(([name]) => name),
        ]),
      );
    }
    for (const key of order) {
      if (!allFunctionAliases.has(key)) {
        const metadata = fileMetadata.get(key)!;
        allFunctionAliases.set(
          key,
          new Set([
            ...metadata.privateAliases.keys(),
            ...Array.from(metadata.originalExports)
              .filter(([, kind]) => kind === "function")
              .map(([name]) => name),
          ]),
        );
      }
    }
    const externalSymbols = sanitizeSymbols(
      group.externalSymbols,
      `snapshot.groups[${index}].externalSymbols`,
      address,
      fileKeys,
      copy,
    );
    groups.push({
      id,
      root,
      handle,
      order,
      lazyFunctions,
      placements,
      functionSlots: functionSlotGroups,
      externalSymbols,
    });
  }

  const tableSlots: (DylinkWorkerTableSlot | null)[] = [];
  const tableSlotInput = arrayValue(main.tableSlots, "snapshot.main.tableSlots");
  if (tableSlotInput.length !== tableLength)
    fail("snapshot table slot image does not match table length");
  for (const [index, item] of tableSlotInput.entries()) {
    if (item === null) {
      tableSlots.push(null);
      continue;
    }
    const slot = plainRecord(
      item,
      ["moduleKey", "exportAlias"],
      ["moduleKey", "exportAlias"],
      `snapshot.main.tableSlots[${index}]`,
    );
    const moduleKey = text(slot.moduleKey, `snapshot.main.tableSlots[${index}].moduleKey`);
    const exportAlias = text(slot.exportAlias, `snapshot.main.tableSlots[${index}].exportAlias`);
    if (moduleKey === "main") {
      if (!mainFunctions.has(exportAlias))
        fail(`table slot references unknown main function alias ${exportAlias}`);
    } else if (!fileKeys.has(moduleKey) || !allFunctionAliases.get(moduleKey)?.has(exportAlias)) {
      fail(`table slot references unknown dynamic function alias ${moduleKey}.${exportAlias}`);
    }
    tableSlots.push({ moduleKey, exportAlias });
  }

  const addressNames: [string, bigint][] = [];
  const addressNameSet = new Set<string>();
  for (const [index, entry] of arrayValue(
    main.addressNames,
    "snapshot.main.addressNames",
  ).entries()) {
    const [nameValue, addressValue] = tuple(entry, 2, `snapshot.main.addressNames[${index}]`);
    const name = text(nameValue, `snapshot.main.addressNames[${index}][0]`);
    const pointer = word(addressValue, `snapshot.main.addressNames[${index}][1]`, address);
    if (pointer === 0n || addressNameSet.has(name))
      fail("snapshot contains a duplicate or null address name");
    addressNameSet.add(name);
    addressNames.push([name, pointer]);
  }

  const objectGroups: [string, DylinkWorkerObjectGroup][] = [];
  const objectKeys = new Set<string>();
  for (const [index, entry] of arrayValue(top.objectGroups, "snapshot.objectGroups").entries()) {
    const [keyValue, objectValue] = tuple(entry, 2, `snapshot.objectGroups[${index}]`);
    const key = text(keyValue, `snapshot.objectGroups[${index}][0]`);
    if (!fileKeys.has(key) || objectKeys.has(key))
      fail("snapshot object group key is invalid or duplicated");
    const object = plainRecord(
      objectValue,
      ["groupId", "root", "handle"],
      ["groupId", "root", "handle"],
      `snapshot.objectGroups[${index}][1]`,
    );
    const groupId = integer(
      object.groupId,
      `snapshot.objectGroups[${index}].groupId`,
      0,
      Math.max(0, groups.length - 1),
    );
    const group = groups[groupId];
    const root = text(object.root, `snapshot.objectGroups[${index}].root`);
    const handle = word(object.handle, `snapshot.objectGroups[${index}].handle`, address);
    if (!group || root !== group.root || !group.order.includes(key))
      fail("snapshot object group does not match its group");
    const file = filesByKey.get(key)!;
    if (file.handle !== undefined && file.handle !== handle)
      fail(`snapshot handle mismatch for ${key}`);
    if (key === root && group.handle !== handle) fail(`snapshot root handle mismatch for ${key}`);
    objectKeys.add(key);
    objectGroups.push([key, { groupId, root, handle }]);
  }
  if (objectKeys.size !== filesByKey.size) fail("snapshot is missing an object group");

  const aliases = uniqueStringPairs(top.aliases, "snapshot.aliases");
  if (aliases.some(([, key]) => !fileKeys.has(key)))
    fail("snapshot alias references an unknown file");
  const globalOrder = arrayValue(top.globalOrder, "snapshot.globalOrder").map((key, index) =>
    text(key, `snapshot.globalOrder[${index}]`),
  );
  if (
    new Set(globalOrder).size !== globalOrder.length ||
    globalOrder.some((key) => !fileKeys.has(key))
  )
    fail("snapshot global symbol order is invalid");

  const owners: [string, number][] = [];
  const ownerIds = new Set<number>();
  const ownerKeys = new Set<string>();
  for (const [index, entry] of arrayValue(top.owners, "snapshot.owners").entries()) {
    const [nameValue, ownerValue] = tuple(entry, 2, `snapshot.owners[${index}]`);
    const name = text(nameValue, `snapshot.owners[${index}][0]`);
    const owner = integer(ownerValue, `snapshot.owners[${index}][1]`, 1, 0xffff_ffff);
    if (ownerKeys.has(name) || ownerIds.has(owner)) fail("snapshot owner mapping conflicts");
    ownerKeys.add(name);
    ownerIds.add(owner);
    owners.push([name, owner]);
  }
  const ownerNames: [number, string][] = [];
  const reverseIds = new Set<number>();
  for (const [index, entry] of arrayValue(top.ownerNames, "snapshot.ownerNames").entries()) {
    const [ownerValue, nameValue] = tuple(entry, 2, `snapshot.ownerNames[${index}]`);
    const owner = integer(ownerValue, `snapshot.ownerNames[${index}][0]`, 1, 0xffff_ffff);
    const name = text(nameValue, `snapshot.ownerNames[${index}][1]`);
    if (
      reverseIds.has(owner) ||
      owners.find(([key, value]) => key === name && value === owner) === undefined
    )
      fail("snapshot owner reverse mapping conflicts");
    reverseIds.add(owner);
    ownerNames.push([owner, name]);
  }
  if (reverseIds.size !== ownerIds.size) fail("snapshot owner maps are incomplete");
  const nextOwner = integer(top.nextOwner, "snapshot.nextOwner", 1, 0x1_0000_0000);
  if ([...ownerIds].some((owner) => owner >= nextOwner))
    fail("snapshot next owner is not above published owners");

  const symbols = sanitizeSymbols(top.symbols, "snapshot.symbols", address, fileKeys, copy);
  const groupRootsWithFiles = new Set(groups.flatMap((group) => group.order));
  if ([...filesByKey.keys()].some((key) => !groupRootsWithFiles.has(key)))
    fail("snapshot has an ungrouped dynamic file");

  const placements = [...placementsByKey].map(([key, value]) => ({
    key,
    ...value,
    metadata: fileMetadata.get(key)!.metadata,
  }));
  for (let left = 0; left < placements.length; left++) {
    const a = placements[left]!;
    const aMemoryEnd = a.base + BigInt(a.metadata.memorySize);
    const aTableEnd = a.tableBase + BigInt(a.metadata.tableSize);
    for (let right = left + 1; right < placements.length; right++) {
      const b = placements[right]!;
      const bMemoryEnd = b.base + BigInt(b.metadata.memorySize);
      const bTableEnd = b.tableBase + BigInt(b.metadata.tableSize);
      if (
        (a.base < bMemoryEnd && b.base < aMemoryEnd) ||
        (a.tableBase < bTableEnd && b.tableBase < aTableEnd)
      )
        fail(`snapshot dynamic placements overlap: ${a.key} and ${b.key}`);
    }
  }

  return {
    version: 1,
    address,
    tableAddress,
    main: {
      handle: mainHandle,
      lastMap,
      cursor,
      tableLength,
      functionSlots,
      tableSlots,
      addressNames,
    },
    files,
    groups,
    objectGroups,
    aliases,
    globalOrder,
    owners,
    ownerNames,
    nextOwner,
    symbols,
  };
}

/** Validate and detach a replay snapshot before it crosses a Worker boundary. */
export function prepare_dylink_worker_snapshot(input: unknown): DylinkWorkerSnapshot {
  return retainValidatedSnapshot(sanitizeWorkerSnapshot(input, true));
}

/** Runtime counterpart for snapshots received through a structured-clone message. */
export function validate_dylink_worker_snapshot(
  input: unknown,
): asserts input is DylinkWorkerSnapshot {
  sanitizeWorkerSnapshot(input, false);
}

function clonePublicationValue(
  value: unknown,
  label: string,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value === null || value === undefined) return value;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return value;
  if (typeof value !== "object") fail(`${label} is not structured-clone data`);
  if (value instanceof Uint8Array) {
    if (!(value.buffer instanceof ArrayBuffer)) fail(`${label} is not backed by an ArrayBuffer`);
    try {
      return new Uint8Array(value);
    } catch (error) {
      if (error instanceof RangeError)
        noMemory(`${label} cannot be copied into a Worker publication`, error);
      throw error;
    }
  }
  if (ancestors.has(value)) fail(`${label} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = arrayValue(value, label);
      return entries.map((entry, index) =>
        clonePublicationValue(entry, `${label}[${index}]`, ancestors),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      fail(`${label} has a non-cloneable prototype`);
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail(`${label} has a non-cloneable key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail(`${label}.${key} is an accessor`);
      Object.defineProperty(result, key, {
        value: clonePublicationValue(descriptor.value, `${label}.${key}`, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function publicationBase(snapshot: DylinkWorkerSnapshot): DylinkWorkerPublication["base"] {
  return {
    mainHandle: snapshot.main.handle,
    lastMap: snapshot.main.lastMap,
    cursor: snapshot.main.cursor,
    tableLength: snapshot.main.tableLength,
    fileCount: snapshot.files.length,
    groupCount: snapshot.groups.length,
    objectCount: snapshot.objectGroups.length,
  };
}

function samePublicationBase(
  left: DylinkWorkerPublication["base"],
  right: DylinkWorkerPublication["base"],
): boolean {
  return (
    left.mainHandle === right.mainHandle &&
    left.lastMap === right.lastMap &&
    left.cursor === right.cursor &&
    left.tableLength === right.tableLength &&
    left.fileCount === right.fileCount &&
    left.groupCount === right.groupCount &&
    left.objectCount === right.objectCount
  );
}

/**
 * Detach an append-only publication draft from the caller. `currentInput` must
 * be a privately prepared/applied snapshot; the draft contains only records
 * added by one successful graph commit, never a second full graph snapshot.
 */
export function prepare_dylink_worker_publication(
  currentInput: DylinkWorkerSnapshot,
  processIdentity: string,
  baseGeneration: number,
  draftInput: unknown,
): DylinkWorkerPublication {
  requireValidatedSnapshot(currentInput, "publication base");
  const identity = text(processIdentity, "publication.processIdentity");
  const currentGeneration = integer(
    baseGeneration,
    "publication.baseGeneration",
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const generation = currentGeneration + 1;
  const draft = plainRecord(
    clonePublicationValue(draftInput, "publication draft"),
    [
      "main",
      "files",
      "groups",
      "groupFunctionSlots",
      "objectGroups",
      "aliases",
      "globalOrder",
      "owners",
      "ownerNames",
      "nextOwner",
      "symbols",
    ],
    [
      "main",
      "files",
      "groups",
      "groupFunctionSlots",
      "objectGroups",
      "aliases",
      "globalOrder",
      "owners",
      "ownerNames",
      "nextOwner",
      "symbols",
    ],
    "publication draft",
  ) as unknown as DylinkWorkerPublicationDraft;
  const delta: DylinkWorkerPublication = {
    version: 1,
    processIdentity: identity,
    baseGeneration: currentGeneration,
    generation,
    address: currentInput.address,
    tableAddress: currentInput.tableAddress,
    base: publicationBase(currentInput),
    ...draft,
  };
  freezePublicationGraph(delta);
  return delta;
}

/** Apply a publication to a validated snapshot without mutating the old generation. */
export function apply_dylink_worker_publication(
  currentInput: DylinkWorkerSnapshot,
  processIdentity: string,
  currentGeneration: number,
  input: unknown,
): { snapshot: DylinkWorkerSnapshot; generation: number } {
  requireValidatedSnapshot(currentInput, "publication receiver base");
  const current = currentInput;
  const identity = text(processIdentity, "publication receiver identity");
  const generation = integer(
    currentGeneration,
    "publication current generation",
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  let cloned: unknown;
  try {
    cloned = clonePublicationValue(input, "publication");
  } catch (error) {
    if (error instanceof DylinkWorkerSnapshotError) throw error;
    if (error instanceof RangeError) noMemory("cannot copy dynamic Worker publication", error);
    throw error;
  }
  const top = plainRecord(
    cloned,
    [
      "version",
      "processIdentity",
      "baseGeneration",
      "generation",
      "address",
      "tableAddress",
      "base",
      "main",
      "files",
      "groups",
      "groupFunctionSlots",
      "objectGroups",
      "aliases",
      "globalOrder",
      "owners",
      "ownerNames",
      "nextOwner",
      "symbols",
    ],
    [
      "version",
      "processIdentity",
      "baseGeneration",
      "generation",
      "address",
      "tableAddress",
      "base",
      "main",
      "files",
      "groups",
      "groupFunctionSlots",
      "objectGroups",
      "aliases",
      "globalOrder",
      "owners",
      "ownerNames",
      "nextOwner",
      "symbols",
    ],
    "publication",
  );
  if (top.version !== 1)
    unsupported("dynamic Worker publication version is missing or unsupported");
  if (top.processIdentity !== identity) fail("publication belongs to a different process");
  const baseGeneration = integer(
    top.baseGeneration,
    "publication.baseGeneration",
    0,
    Number.MAX_SAFE_INTEGER - 1,
  );
  const nextGeneration = integer(
    top.generation,
    "publication.generation",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (baseGeneration !== generation || nextGeneration !== baseGeneration + 1)
    fail("publication generation does not match the receiver");
  if (top.address !== current.address || top.tableAddress !== current.tableAddress)
    fail("publication address ABI does not match the receiver");

  const base = plainRecord(
    top.base,
    ["mainHandle", "lastMap", "cursor", "tableLength", "fileCount", "groupCount", "objectCount"],
    ["mainHandle", "lastMap", "cursor", "tableLength", "fileCount", "groupCount", "objectCount"],
    "publication.base",
  );
  const expectedBase: DylinkWorkerPublication["base"] = {
    mainHandle: word(base.mainHandle, "publication.base.mainHandle", current.address),
    lastMap: word(base.lastMap, "publication.base.lastMap", current.address),
    cursor: word(base.cursor, "publication.base.cursor", current.tableAddress, true),
    tableLength: integer(base.tableLength, "publication.base.tableLength", 0, 0xffff_ffff),
    fileCount: integer(base.fileCount, "publication.base.fileCount"),
    groupCount: integer(base.groupCount, "publication.base.groupCount"),
    objectCount: integer(base.objectCount, "publication.base.objectCount"),
  };
  if (!samePublicationBase(expectedBase, publicationBase(current)))
    fail("publication base snapshot does not match the receiver");

  const main = plainRecord(
    top.main,
    ["handle", "lastMap", "cursor", "tableLength", "functionSlots", "tableSlots", "addressNames"],
    ["handle", "lastMap", "cursor", "tableLength", "functionSlots", "tableSlots", "addressNames"],
    "publication.main",
  );
  const handle = word(main.handle, "publication.main.handle", current.address);
  const lastMap = word(main.lastMap, "publication.main.lastMap", current.address);
  const cursor = word(main.cursor, "publication.main.cursor", current.tableAddress, true);
  const tableLength = integer(main.tableLength, "publication.main.tableLength", 0, 0xffff_ffff);
  if (
    handle !== current.main.handle ||
    cursor < current.main.cursor ||
    tableLength < current.main.tableLength ||
    cursor > BigInt(tableLength)
  )
    fail("publication main metadata is not an append-only extension");

  const tableSlots = [...current.main.tableSlots];
  while (tableSlots.length < tableLength) tableSlots.push(null);
  const tableWrites: [number, DylinkWorkerTableSlot][] = [];
  for (const [index, item] of arrayValue(
    main.tableSlots,
    "publication.main.tableSlots",
  ).entries()) {
    const [slotIndexValue, slotValue] = tuple(item, 2, `publication.main.tableSlots[${index}]`);
    const slotIndex = integer(
      slotIndexValue,
      `publication.main.tableSlots[${index}][0]`,
      0,
      0xffff_ffff,
    );
    if (slotIndex >= tableLength || slotIndex >= tableSlots.length)
      fail("publication table write exceeds the new table length");
    const slot = plainRecord(
      slotValue,
      ["moduleKey", "exportAlias"],
      ["moduleKey", "exportAlias"],
      `publication table slot ${slotIndex}`,
    );
    const descriptor: DylinkWorkerTableSlot = {
      moduleKey: text(slot.moduleKey, `publication table slot ${slotIndex}.moduleKey`),
      exportAlias: text(slot.exportAlias, `publication table slot ${slotIndex}.exportAlias`),
    };
    if (tableSlots[slotIndex] !== null || BigInt(slotIndex) < current.main.cursor)
      fail(`publication rewrites canonical table slot ${slotIndex}`);
    tableSlots[slotIndex] = descriptor;
    tableWrites.push([slotIndex, descriptor]);
  }
  tableWrites.sort(([left], [right]) => left - right);
  if (new Set(tableWrites.map(([index]) => index)).size !== tableWrites.length)
    fail("publication writes a table slot more than once");

  const functionSlots = arrayValue(main.functionSlots, "publication.main.functionSlots");
  const addressNames = arrayValue(main.addressNames, "publication.main.addressNames");
  const groupFunctionSlots: [number, DylinkWorkerGroup["functionSlots"]][] = [];
  for (const [index, entry] of arrayValue(
    top.groupFunctionSlots,
    "publication.groupFunctionSlots",
  ).entries()) {
    const [groupIdValue, slotsValue] = tuple(entry, 2, `publication.groupFunctionSlots[${index}]`);
    const groupId = integer(
      groupIdValue,
      `publication.groupFunctionSlots[${index}][0]`,
      0,
      Math.max(0, current.groups.length - 1),
    );
    if (!current.groups[groupId]) fail("publication updates an unknown module group");
    const moduleSlots: [string, [string, bigint][]][] = [];
    for (const [moduleIndex, moduleEntry] of arrayValue(
      slotsValue,
      `publication.groupFunctionSlots[${index}][1]`,
    ).entries()) {
      const [keyValue, aliasesValue] = tuple(
        moduleEntry,
        2,
        `publication.groupFunctionSlots[${index}][1][${moduleIndex}]`,
      );
      const key = text(keyValue, "publication group function-slot key");
      const aliases = arrayValue(aliasesValue, "publication group function-slot aliases").map(
        (aliasEntry, aliasIndex) => {
          const [nameValue, slotValue] = tuple(
            aliasEntry,
            2,
            `publication group function-slot alias ${aliasIndex}`,
          );
          return [
            text(nameValue, "publication group function alias"),
            word(slotValue, "publication group function slot", current.tableAddress),
          ] as [string, bigint];
        },
      );
      moduleSlots.push([key, aliases]);
    }
    groupFunctionSlots.push([groupId, moduleSlots]);
  }

  const mergedGroups = [
    ...current.groups,
    ...arrayValue(top.groups, "publication.groups"),
  ] as DylinkWorkerGroup[];
  const candidate: DylinkWorkerSnapshot = {
    version: 1,
    address: current.address,
    tableAddress: current.tableAddress,
    main: {
      handle,
      lastMap,
      cursor,
      tableLength,
      functionSlots: [
        ...current.main.functionSlots,
        ...functionSlots,
      ] as DylinkWorkerFunctionSlot[],
      tableSlots,
      addressNames: [...current.main.addressNames, ...addressNames] as (readonly [
        string,
        bigint,
      ])[],
    },
    files: [...current.files, ...arrayValue(top.files, "publication.files")] as DylinkWorkerFile[],
    groups: mergedGroups,
    objectGroups: [
      ...current.objectGroups,
      ...arrayValue(top.objectGroups, "publication.objectGroups"),
    ] as DylinkWorkerSnapshot["objectGroups"],
    aliases: [
      ...current.aliases,
      ...arrayValue(top.aliases, "publication.aliases"),
    ] as DylinkWorkerSnapshot["aliases"],
    globalOrder: [
      ...current.globalOrder,
      ...arrayValue(top.globalOrder, "publication.globalOrder"),
    ] as string[],
    owners: [
      ...current.owners,
      ...arrayValue(top.owners, "publication.owners"),
    ] as DylinkWorkerSnapshot["owners"],
    ownerNames: [
      ...current.ownerNames,
      ...arrayValue(top.ownerNames, "publication.ownerNames"),
    ] as DylinkWorkerSnapshot["ownerNames"],
    nextOwner: integer(top.nextOwner, "publication.nextOwner", current.nextOwner, 0x1_0000_0000),
    symbols: [
      ...current.symbols,
      ...arrayValue(top.symbols, "publication.symbols"),
    ] as DylinkWorkerSymbols,
  };

  for (const [groupId, updates] of groupFunctionSlots) {
    const group = candidate.groups[groupId]!;
    const byModule = new Map(updates);
    mergedGroups[groupId] = {
      ...group,
      functionSlots: group.functionSlots.map(([key, slots]) => {
        const extra = byModule.get(key);
        if (!extra) return [key, slots];
        byModule.delete(key);
        return [key, [...slots, ...extra]];
      }),
    };
    if (byModule.size) fail("publication adds function slots for an unknown module");
  }

  validate_dylink_worker_snapshot(candidate);
  retainValidatedSnapshot(candidate);
  return { snapshot: candidate, generation: nextGeneration };
}
