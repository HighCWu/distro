// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { kernel_imports, type WasmAddressType } from "../src/wasm.ts";

function imports(memory: WebAssembly.Memory, address: WasmAddressType) {
  return kernel_imports({
    address,
    memory,
    is_worker: true,
    spawn_worker: () => {
      throw new Error("unexpected spawn");
    },
    boot_console_write: () => {},
    boot_console_close: () => {},
    terminate_machine: () => {},
    run_on_main: () => {},
    get_user_context: () => null,
    worker_exit: () => {},
  });
}

function withStack(stack: string | undefined, run: () => void) {
  const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: () => stack });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(Error, "prepareStackTrace", original);
    else Reflect.deleteProperty(Error, "prepareStackTrace");
  }
}

for (const address of ["i32", "i64"] as const) {
  const word = (value: number) => (address === "i64" ? BigInt(value) : value);
  test(`${address}: kernel trace import terminates empty, exact and truncated C strings`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(memory.buffer);
    const { get_stacktrace } = imports(memory, address);
    for (const content of ["", "x", "short", "abcdefghijklmnopqrstuvwxyz", "函数é"]) {
      withStack(`Error\n1\n2\n3\n4\n${content}`, () => {
        for (const capacity of [0, 1, 2, 3, 4, 8, 32]) {
          bytes.fill(0xa5);
          get_stacktrace(word(16), word(capacity));
          const encoded = new TextEncoder().encode(content);
          const expected = new Uint8Array(capacity).fill(0xa5);
          if (capacity) {
            const length = Math.min(encoded.byteLength, capacity - 1);
            expected.set(encoded.subarray(0, length));
            if (encoded.byteLength > length && length >= 3) expected.fill(46, length - 3, length);
            expected[length] = 0;
          }
          assert.deepEqual(bytes.slice(16, 16 + capacity), expected);
          assert.ok(bytes.slice(0, 16).every((value) => value === 0xa5));
          assert.ok(bytes.slice(16 + capacity).every((value) => value === 0xa5));
        }
      });
    }
    bytes.fill(0xa5);
    withStack(undefined, () => get_stacktrace(word(16), word(8)));
    assert.equal(bytes[16], 0);
    assert.equal(bytes[17], 0xa5);
  });

  test(`${address}: kernel trace rejects overflowing ranges without mutating memory`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const bytes = new Uint8Array(memory.buffer);
    bytes.fill(0xa5);
    const { get_stacktrace } = imports(memory, address);
    assert.throws(() => get_stacktrace(word(bytes.length - 1), word(2)), RangeError);
    assert.throws(() => get_stacktrace(word(1), word(bytes.length)), RangeError);
    assert.throws(() => get_stacktrace(word(0), word(-1)), RangeError);
    if (address === "i32") assert.doesNotThrow(() => get_stacktrace(-0x80000000, 0));
    else assert.throws(() => get_stacktrace(1n << 54n, 1n), RangeError);
    assert.ok(bytes.every((value) => value === 0xa5));
  });
}
