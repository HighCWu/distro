// SPDX-License-Identifier: MIT

import {
  memory_bytes,
  wasm_address_from_number,
  wasm_pointer_to_number,
  wasm_size_to_number,
} from "./wasm.ts";
import type { WasmAddressType } from "./wasm.ts";

const descriptorName = "__wasm_fork_memory_advice_v1";
const descriptorWords = 8;
const pageSize = 65536;

function requireInteger(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`invalid fork memory advice ${name}`);
  return value;
}

/** Apply the child-side WIPEONFORK ranges without entering the Wasm C stack.
 * The exported Global points at a v1, eight-word descriptor in linear memory. */
export function apply_fork_memory_advice(
  exports: WebAssembly.Exports,
  memory: WebAssembly.Memory,
  addressType: WasmAddressType,
): void {
  if (!Object.prototype.hasOwnProperty.call(exports, descriptorName)) return;
  const descriptor = (exports as Record<string, unknown>)[descriptorName];
  if (!(descriptor instanceof WebAssembly.Global))
    throw new TypeError("fork memory advice descriptor is not a WebAssembly.Global");

  const wordSize = addressType === "i64" ? 8 : 4;
  const descriptorValue = descriptor.value;
  if (
    (addressType === "i32" && typeof descriptorValue !== "number") ||
    (addressType === "i64" && typeof descriptorValue !== "bigint")
  )
    throw new TypeError("fork memory advice descriptor has the wrong address width");
  const descriptorAddress = requireInteger(
    wasm_pointer_to_number(descriptorValue as number | bigint),
    "descriptor address",
    1,
  );
  if (descriptorAddress % wordSize !== 0)
    throw new RangeError("fork memory advice descriptor address is misaligned");
  const viewAt = (address: number, length: number, name: string) => {
    const bytes = memory_bytes(
      memory,
      wasm_address_from_number(address, addressType),
      wasm_address_from_number(length, addressType),
    );
    if (!bytes) throw new RangeError(`fork memory advice ${name} is out of bounds`);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
  const readWord = (view: DataView, offset: number) =>
    addressType === "i64"
      ? wasm_size_to_number(view.getBigUint64(offset, true))
      : wasm_size_to_number(view.getUint32(offset, true));
  const descriptorView = viewAt(descriptorAddress, descriptorWords * wordSize, "descriptor");
  const word = (index: number) => readWord(descriptorView, index * wordSize);

  const version = word(0);
  const recordSize = word(1);
  const headVariable = word(2);
  const nextOffset = word(3);
  const addressOffset = word(4);
  const lengthOffset = word(5);
  const initializedOffset = word(6);
  const wipeOffset = word(7);
  if (version !== 1) throw new Error("unsupported fork memory advice descriptor version");
  requireInteger(recordSize, "record size", 1);
  requireInteger(headVariable, "list head address", 1);
  if (headVariable % wordSize !== 0)
    throw new RangeError("fork memory advice list head address is misaligned");
  if (recordSize > memory.buffer.byteLength)
    throw new RangeError("fork memory advice record exceeds linear memory");

  const fields = [
    { name: "next", offset: nextOffset, size: wordSize },
    { name: "address", offset: addressOffset, size: wordSize },
    { name: "length", offset: lengthOffset, size: wordSize },
    { name: "initialized", offset: initializedOffset, size: 4 },
    { name: "wipe", offset: wipeOffset, size: 4 },
  ];
  for (const field of fields) {
    requireInteger(field.offset, `${field.name} offset`);
    if (field.offset > recordSize - field.size)
      throw new RangeError(`fork memory advice ${field.name} offset exceeds record size`);
  }
  const orderedFields = [...fields].sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < orderedFields.length; index++) {
    const previous = orderedFields[index - 1]!;
    const current = orderedFields[index]!;
    if (current.offset < previous.offset + previous.size)
      throw new Error("overlapping fork memory advice record fields");
  }

  const head = readWord(viewAt(headVariable, wordSize, "list head"), 0);
  const maximumRecords = Math.floor(memory.buffer.byteLength / pageSize);
  const visited = new Set<number>();
  const rangesToClear: { address: number; length: number }[] = [];
  let current = head;
  let recordCount = 0;
  while (current !== 0) {
    if (++recordCount > maximumRecords)
      throw new RangeError("fork memory advice list exceeds its node limit");
    if (visited.has(current)) throw new Error("cycle in fork memory advice list");
    if (current % wordSize !== 0)
      throw new RangeError("fork memory advice record address is misaligned");
    visited.add(current);

    const record = viewAt(current, recordSize, "record");
    const next = readWord(record, nextOffset);
    const address = readWord(record, addressOffset);
    const length = readWord(record, lengthOffset);
    const initialized = record.getInt32(initializedOffset, true);
    const wipe = record.getInt32(wipeOffset, true);
    if ((initialized !== 0 && initialized !== 1) || (wipe !== 0 && wipe !== 1))
      throw new Error("invalid fork memory advice flags");
    if (
      length === 0 ||
      address % pageSize !== 0 ||
      length % pageSize !== 0 ||
      address > memory.buffer.byteLength - length
    )
      throw new RangeError("invalid fork memory advice range");
    if (wipe === 1 && initialized !== 0)
      throw new Error("initialized fork memory range cannot be wiped");
    if (wipe === 1) rangesToClear.push({ address, length });
    current = next;
  }

  // Resolve every view before mutating memory. A malformed later node must not
  // leave a partially wiped child image.
  const views = rangesToClear.map(({ address, length }) => {
    const bytes = memory_bytes(
      memory,
      wasm_address_from_number(address, addressType),
      wasm_address_from_number(length, addressType),
    );
    if (!bytes) throw new RangeError("fork memory advice range is out of bounds");
    return bytes;
  });
  for (const bytes of views) bytes.fill(0);
}
