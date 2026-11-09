// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { apply_fork_memory_advice } from "../src/fork-memory-advice.ts";
import type { WasmAddressType, WasmMemoryDescriptor } from "../src/wasm.ts";

type Row = {
  address: number;
  length: number;
  initialized: number;
  wipe: number;
  next?: number;
};

function fixture(
  addressType: WasmAddressType,
  rows: Row[],
  options: { version?: number; recordSize?: number; nextOffset?: number } = {},
) {
  const wordSize = addressType === "i64" ? 8 : 4;
  const memory = new WebAssembly.Memory({
    initial: addressType === "i64" ? 4n : 4,
    maximum: addressType === "i64" ? 4n : 4,
    address: addressType,
  } as WasmMemoryDescriptor as WebAssembly.MemoryDescriptor);
  const view = new DataView(memory.buffer);
  const descriptorAddress = 64;
  const headVariableAddress = 128;
  const recordSize = options.recordSize ?? wordSize * 3 + 8;
  const nextOffset = options.nextOffset ?? 0;
  const addressOffset = wordSize;
  const lengthOffset = wordSize * 2;
  const initializedOffset = wordSize * 3;
  const wipeOffset = initializedOffset + 4;
  const recordAddresses = rows.map((_, index) => 256 + index * 256);

  const writeWord = (offset: number, value: number) => {
    if (addressType === "i64") view.setBigUint64(offset, BigInt(value), true);
    else view.setUint32(offset, value, true);
  };
  const writeDescriptorWord = (index: number, value: number) =>
    writeWord(descriptorAddress + index * wordSize, value);

  writeDescriptorWord(0, options.version ?? 1);
  writeDescriptorWord(1, recordSize);
  writeDescriptorWord(2, headVariableAddress);
  writeDescriptorWord(3, nextOffset);
  writeDescriptorWord(4, addressOffset);
  writeDescriptorWord(5, lengthOffset);
  writeDescriptorWord(6, initializedOffset);
  writeDescriptorWord(7, wipeOffset);
  writeWord(headVariableAddress, recordAddresses[0] ?? 0);

  for (const [index, row] of rows.entries()) {
    const recordAddress = recordAddresses[index]!;
    writeWord(recordAddress + nextOffset, row.next === undefined ? 0 : recordAddresses[row.next]!);
    writeWord(recordAddress + addressOffset, row.address);
    writeWord(recordAddress + lengthOffset, row.length);
    view.setInt32(recordAddress + initializedOffset, row.initialized, true);
    view.setInt32(recordAddress + wipeOffset, row.wipe, true);
    new Uint8Array(memory.buffer, row.address, row.length).fill(index + 1);
  }

  const descriptorGlobal = new WebAssembly.Global(
    { value: addressType, mutable: false },
    addressType === "i64" ? BigInt(descriptorAddress) : descriptorAddress,
  );
  return {
    memory,
    rows,
    exports: { __wasm_fork_memory_advice_v1: descriptorGlobal },
  };
}

for (const addressType of ["i32", "i64"] as const) {
  test(`${addressType}: wipes only initialized-safe WIPEONFORK ranges`, () => {
    const { memory, exports } = fixture(addressType, [
      { address: 65536, length: 65536, initialized: 0, wipe: 1, next: 1 },
      { address: 131072, length: 65536, initialized: 1, wipe: 0 },
    ]);

    apply_fork_memory_advice(exports, memory, addressType);
    assert.deepEqual(new Uint8Array(memory.buffer, 65536, 65536), new Uint8Array(65536));
    assert.ok(new Uint8Array(memory.buffer, 131072, 65536).every((byte) => byte === 2));
  });

  test(`${addressType}: validates the entire list before clearing any range`, () => {
    const { memory, exports } = fixture(addressType, [
      { address: 65536, length: 65536, initialized: 0, wipe: 1, next: 1 },
      { address: 131073, length: 65536, initialized: 0, wipe: 1 },
    ]);

    assert.throws(() => apply_fork_memory_advice(exports, memory, addressType));
    assert.ok(new Uint8Array(memory.buffer, 65536, 65536).every((byte) => byte === 1));
  });
}

test("fork memory advice accepts old modules without a descriptor", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  assert.doesNotThrow(() => apply_fork_memory_advice({}, memory, "i32"));
});

test("fork memory advice rejects malformed versions, cycles, flags and exports", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wrongExport = { __wasm_fork_memory_advice_v1: 64 };
  assert.throws(() =>
    apply_fork_memory_advice(wrongExport as unknown as WebAssembly.Exports, memory, "i32"),
  );

  for (const { rows, options } of [
    {
      rows: [{ address: 65536, length: 65536, initialized: 0, wipe: 1 }],
      options: { version: 2 },
    },
    {
      rows: [{ address: 65536, length: 65536, initialized: 0, wipe: 1, next: 0 }],
      options: {},
    },
    {
      rows: [{ address: 65536, length: 65536, initialized: 1, wipe: 1 }],
      options: {},
    },
    {
      rows: [{ address: 65536, length: 65536, initialized: 0, wipe: 2 }],
      options: {},
    },
  ]) {
    const values = fixture("i32", rows, options);
    assert.throws(() => apply_fork_memory_advice(values.exports, values.memory, "i32"));
  }
});
