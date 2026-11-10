// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { user_function_imports_supported } from "../src/user-functions.ts";

const leb = (value: number) => {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return bytes;
};

const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
};

const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];

function address_import_module(
  firstParameter: number,
  secondParameter: number,
  result: number,
  exportEntry = true,
) {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const addressType = [0x60, 2, firstParameter, secondParameter, 1, result];
  const startType = [0x60, 0, 0];
  const types = [2, ...addressType, ...startType];
  const imports = [1, ...text("linux_dlopen_v1"), ...text("address"), 0, 0];
  const functions = [1, 1];
  const exports = exportEntry ? [1, ...text("_start"), 0, 1] : [0];
  const code = [1, 2, 0, 0x0b];
  return new Uint8Array([
    ...header,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, functions),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

test("dynamic-loader address import matches wasm32 and wasm64 typed providers", () => {
  for (const address of ["i32", "i64"] as const) {
    const pointer = address === "i64" ? 0x7e : 0x7f;
    const bytes = address_import_module(pointer, pointer, 0x7f);
    assert.doesNotThrow(() => new WebAssembly.Module(bytes));
    assert.equal(user_function_imports_supported(bytes, address, true), true, address);
  }
});

test("dynamic-loader address import rejects a wrong result or pointer width", () => {
  const i32 = 0x7f;
  const i64 = 0x7e;
  const wrongResult = address_import_module(i64, i64, i64);
  const wrongPointer = address_import_module(i32, i64, i32);
  assert.doesNotThrow(() => new WebAssembly.Module(wrongResult));
  assert.doesNotThrow(() => new WebAssembly.Module(wrongPointer));
  assert.equal(user_function_imports_supported(wrongResult, "i64", true), false);
  assert.equal(user_function_imports_supported(wrongPointer, "i64", true), false);
});

function signal_syscall_import_module(pointer: number, abiResult = 0x7f, operationResult = 0x7f) {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const types = [3, 0x60, 0, 1, abiResult, 0x60, 1, pointer, 1, operationResult, 0x60, 0, 0];
  const imports = [
    3,
    ...text("linux_signal_syscall_v1"),
    ...text("abi"),
    0,
    0,
    ...text("linux_signal_syscall_v1"),
    ...text("frame"),
    0,
    1,
    ...text("linux_signal_syscall_v1"),
    ...text("finish"),
    0,
    1,
  ];
  const functions = [1, 2];
  const exports = [1, ...text("_start"), 0, 3];
  const code = [1, 2, 0, 0x0b];
  return new Uint8Array([
    ...header,
    ...section(1, types),
    ...section(2, imports),
    ...section(3, functions),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

test("signal syscall imports have fixed i32 results and pointer-width addresses", () => {
  for (const address of ["i32", "i64"] as const) {
    const pointer = address === "i64" ? 0x7e : 0x7f;
    const bytes = signal_syscall_import_module(pointer);
    assert.doesNotThrow(() => new WebAssembly.Module(bytes));
    assert.equal(user_function_imports_supported(bytes, address, true), true, address);
  }
});

test("signal syscall import admission rejects wrong result or pointer widths", () => {
  const i32 = 0x7f;
  const i64 = 0x7e;
  const wrongFramePointer = signal_syscall_import_module(i32);
  const wrongAbiResult = signal_syscall_import_module(i64, i64);
  const wrongFrameResult = signal_syscall_import_module(i64, i32, i64);
  assert.doesNotThrow(() => new WebAssembly.Module(wrongFramePointer));
  assert.doesNotThrow(() => new WebAssembly.Module(wrongAbiResult));
  assert.doesNotThrow(() => new WebAssembly.Module(wrongFrameResult));
  assert.equal(user_function_imports_supported(wrongFramePointer, "i64", true), false);
  assert.equal(user_function_imports_supported(wrongAbiResult, "i64", true), false);
  assert.equal(user_function_imports_supported(wrongFrameResult, "i64", true), false);
});

test("function import admission still requires an exported _start when requested", () => {
  const bytes = address_import_module(0x7f, 0x7f, 0x7f, false);
  assert.doesNotThrow(() => new WebAssembly.Module(bytes));
  assert.equal(user_function_imports_supported(bytes, "i32", true), false);
  assert.equal(user_function_imports_supported(bytes, "i32", false), true);
});
