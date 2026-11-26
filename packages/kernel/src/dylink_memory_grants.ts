// SPDX-License-Identifier: MIT

import type { DylinkHostMemory } from "./dylink_linker.ts";
import type { WasmMemoryType } from "./wasm_binary.ts";

/** @internal Machine-wide grant to an exact module image. The host must trust
 * that image with the entire memory object wherever it is loaded. This grant
 * identifies code; any process or file authorization belongs to its caller. */
export type DylinkMemoryGrant = {
  bytes: Uint8Array<ArrayBuffer>;
  memories: ReadonlyMap<string, ReadonlyMap<string, DylinkHostMemory>>;
};

/** @internal Boot-only capability key; deliberately omitted from package exports. */
export const dylink_memory_grants: unique symbol = Symbol("dylink_memory_grants");

const WASM_PAGE_BYTES = 0x10000;

function invalidGrant(message: string): never {
  throw new TypeError(`invalid dynamic memory grant: ${message}`);
}

function isSharedMemoryBuffer(value: unknown): boolean {
  return typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
}

function isMap(value: unknown): value is ReadonlyMap<unknown, unknown> {
  return value instanceof Map;
}

function copyMemoryType(value: unknown, currentByteLength: number): WasmMemoryType {
  if (typeof value !== "object" || value === null) invalidGrant("memory type must be an object");

  const type = value as Partial<WasmMemoryType>;
  if (
    (type.address !== "i32" && type.address !== "i64") ||
    typeof type.minimum !== "bigint" ||
    type.minimum < 0n ||
    type.shared !== true ||
    typeof type.maximum !== "bigint" ||
    type.maximum < type.minimum
  )
    invalidGrant("memory type must describe shared memory with valid limits");

  if (currentByteLength % WASM_PAGE_BYTES !== 0)
    invalidGrant("shared memory has a non-page-aligned size");
  const currentPages = BigInt(currentByteLength / WASM_PAGE_BYTES);
  if (currentPages < type.minimum || currentPages > type.maximum)
    invalidGrant("shared memory size is outside its declared limits");

  return Object.freeze({
    address: type.address,
    minimum: type.minimum,
    maximum: type.maximum,
    shared: true,
  });
}

function sameMemoryType(left: WasmMemoryType, right: WasmMemoryType): boolean {
  return (
    left.address === right.address &&
    left.minimum === right.minimum &&
    left.maximum === right.maximum &&
    left.shared === right.shared
  );
}

function copyHostMemory(
  value: unknown,
  knownTypes: WeakMap<WebAssembly.Memory, WasmMemoryType>,
): DylinkHostMemory {
  if (typeof value !== "object" || value === null) invalidGrant("memory binding must be an object");
  const binding = value as Partial<DylinkHostMemory>;
  const memory = binding.memory;
  if (!(memory instanceof WebAssembly.Memory))
    invalidGrant("memory binding must be a WebAssembly.Memory");

  let buffer: ArrayBufferLike;
  try {
    buffer = memory.buffer;
  } catch {
    invalidGrant("memory binding is not a usable WebAssembly.Memory");
  }
  // Read this before the SAB check: some TS WebAssembly libs still declare
  // Memory.buffer as ArrayBuffer and narrow it to `never` on the other branch.
  const currentByteLength = buffer.byteLength;
  if (!isSharedMemoryBuffer(buffer)) invalidGrant("auxiliary memory must be shared across Workers");

  const type = copyMemoryType(binding.type, currentByteLength);
  const previousType = knownTypes.get(memory);
  if (previousType && !sameMemoryType(previousType, type))
    invalidGrant("one shared memory has conflicting type descriptors");
  knownTypes.set(memory, type);

  return Object.freeze({
    memory,
    type,
  });
}

function copyMemories(
  value: unknown,
  knownTypes: WeakMap<WebAssembly.Memory, WasmMemoryType> = new WeakMap(),
): ReadonlyMap<string, ReadonlyMap<string, DylinkHostMemory>> {
  if (!isMap(value)) invalidGrant("memory namespaces must be Maps");

  const copied = new Map<string, ReadonlyMap<string, DylinkHostMemory>>();
  let bindingCount = 0;
  for (const [moduleName, fieldsValue] of value) {
    if (typeof moduleName !== "string") invalidGrant("memory namespace names must be strings");
    if (!isMap(fieldsValue)) invalidGrant(`memory fields for ${moduleName} must be a Map`);

    const fields = new Map<string, DylinkHostMemory>();
    for (const [fieldName, memoryValue] of fieldsValue) {
      if (typeof fieldName !== "string") invalidGrant("memory import names must be strings");
      if (moduleName === "env" && fieldName === "memory")
        invalidGrant("env.memory is reserved for process memory");
      fields.set(fieldName, copyHostMemory(memoryValue, knownTypes));
      bindingCount++;
    }
    copied.set(moduleName, fields);
  }
  if (bindingCount === 0) invalidGrant("grant has no auxiliary memory bindings");
  return copied;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++)
    if (left[index] !== right[index]) return false;
  return true;
}

/** @internal Copy and validate host-selected grants before retaining or posting them. */
export function snapshot_dylink_memory_grants(
  grants: readonly DylinkMemoryGrant[],
): readonly DylinkMemoryGrant[] {
  if (!Array.isArray(grants)) invalidGrant("grant list must be an array");

  const snapshots: DylinkMemoryGrant[] = [];
  const byLength = new Map<number, Uint8Array<ArrayBuffer>[]>();
  const knownTypes = new WeakMap<WebAssembly.Memory, WasmMemoryType>();
  for (const [index, grantValue] of grants.entries()) {
    if (typeof grantValue !== "object" || grantValue === null)
      invalidGrant(`grant ${index} must be an object`);

    const grant = grantValue as DylinkMemoryGrant;
    if (!(grant.bytes instanceof Uint8Array) || !(grant.bytes.buffer instanceof ArrayBuffer))
      invalidGrant(`grant ${index} bytes must be an ArrayBuffer-backed Uint8Array`);
    if (grant.bytes.byteLength === 0) invalidGrant(`grant ${index} has an empty byte image`);

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = new Uint8Array(grant.bytes);
    } catch {
      invalidGrant(`grant ${index} byte image could not be copied`);
    }

    const sameLength = byLength.get(bytes.byteLength) ?? [];
    if (sameLength.some((previous) => equalBytes(previous, bytes)))
      invalidGrant(`grant ${index} duplicates an exact byte image`);
    sameLength.push(bytes);
    byLength.set(bytes.byteLength, sameLength);

    snapshots.push(
      Object.freeze({
        bytes,
        memories: copyMemories(grant.memories, knownTypes),
      }),
    );
  }
  return Object.freeze(snapshots);
}

/** @internal Resolve auxiliary-memory authority by exact original module bytes. */
export function create_dylink_memory_resolver(
  grants: readonly DylinkMemoryGrant[],
): (
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
) => ReadonlyMap<string, ReadonlyMap<string, DylinkHostMemory>> | undefined {
  const snapshots = snapshot_dylink_memory_grants(grants);
  return (_name, bytes) => {
    if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer)) return undefined;
    for (const grant of snapshots) {
      if (grant.bytes.byteLength !== bytes.byteLength || !equalBytes(grant.bytes, bytes)) continue;
      // Return fresh maps and descriptor copies so mutation by a linker caller
      // cannot change the resolver's retained authority. The Memory objects
      // themselves are intentionally shared across Workers.
      return copyMemories(grant.memories);
    }
    return undefined;
  };
}
