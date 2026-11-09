// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { ProcessDylink } from "../src/dylink_process.ts";

// Generated from distro/dladdr-runtime/plugin.c using:
// clang --target=wasm32-unknown-unknown -O2 -fPIC -matomics -mbulk-memory -c plugin.c -o plugin.o
// wasm-ld --shared --no-entry --import-memory --shared-memory --max-memory=65536 --import-table --export-dynamic -o plugin.wasm plugin.o
// Keep the output inline so this test does not need the dynamic SDK at runtime.
const picPlugin = Buffer.from(
  [
    "AGFzbQEAAAAADwhkeWxpbmsuMAEEFAQBAAENA2AAAGABfwF/YAABfwJbBANlbnYGbWVtb3J5AgMBAQNlbnYZX19pbmRpcmVjdF9mdW5jdGlvbl90YWJsZQFwAAEDZW52DV9fbWVtb3J5X2Jhc2UDfwADZW52DF9fdGFibGVfYmFzZQN/AAMHBgAAAAEBAgYLAn8BQQALfwBBAAsHaQQYX193YXNtX2FwcGx5X2RhdGFfcmVsb2NzAAEWZGxhZGRyX3BsdWdpbl9mdW5jdGlvbgADHGRsYWRkcl9wbHVnaW5faGlkZGVuX3BvaW50ZXIABRJkbGFkZHJfcGx1Z2luX2RhdGEDAwgBAgkHAQAjAQsBBAwBAQp+BgIACwIAC1EBAn8jAEEQaiEAAkACQAJAIABBAEEB/kgCAA4CAAECC0EAIwBqQQBBEPwIAAAgAEEC/hcCACAAQX/+AAIAGgwBCyAAQQFCf/4BAgAaC/wJAAsKACAAQQNsQQdqCwkAIABB2rQBcwsPACOBgICAAEGAgICAAGoLCxMBARAQITJDVGV2h5ipusvc7f4PAPYBBG5hbWUAHx5sdW5hLWRsYWRkci1wbHVnaW4tYWN0dWFsLndhc20BlwEGABFfX3dhc21fY2FsbF9jdG9ycwEYX193YXNtX2FwcGx5X2RhdGFfcmVsb2NzAhJfX3dhc21faW5pdF9tZW1vcnkDFmRsYWRkcl9wbHVnaW5fZnVuY3Rpb24EHWRsYWRkcl9wbHVnaW5faGlkZGVuX2Z1bmN0aW9uBRxkbGFkZHJfcGx1Z2luX2hpZGRlbl9wb2ludGVyByoDAA1fX21lbW9yeV9iYXNlAQxfX3RhYmxlX2Jhc2UCCl9fdGxzX2Jhc2UJCAEABS5kYXRhADgJcHJvZHVjZXJzAQxwcm9jZXNzZWQtYnkBDFVidW50dSBjbGFuZxExOC4xLjMgKDF1YnVudHUxKQBCD3RhcmdldF9mZWF0dXJlcwQrB2F0b21pY3MrC2J1bGstbWVtb3J5Kw9tdXRhYmxlLWdsb2JhbHMrCHNpZ24tZXh0",
  ].join(""),
  "base64",
);

const leb = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
};
const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
};
const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];

function mainModule() {
  const globals = [
    [0x7f, 1, 0x41, 0, 0x0b], // Mutable stack pointer.
    [0x7f, 0, 0x41, 0xf0, 0x15, 0x0b], // __global_base = 2800.
    [0x7f, 0, 0x41, 0x9c, 0x18, 0x0b], // __data_end = 3100.
    [0x7f, 0, 0x41, 0xb8, 0x17, 0x0b], // Main data address = 3000.
  ];
  const exportEntries = [
    ["__indirect_function_table", 1, 0],
    ["dladdr_runtime_main_function", 0, 0],
    ["__stack_pointer", 3, 0],
    ["__global_base", 3, 1],
    ["__data_end", 3, 2],
    ["dladdr_runtime_main_data", 3, 3],
  ].flatMap(([name, kind, index]) => [...text(String(name)), Number(kind), Number(index)]);
  return new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
      ...section(3, [1, 0]),
      ...section(4, [1, 0x70, 1, 4, 128, 1]),
      ...section(6, [globals.length, ...globals.flat()]),
      ...section(7, [6, ...exportEntries]),
      ...section(9, [1, 0, 0x41, 3, 0x0b, 1, 0]),
      ...section(10, [1, 7, 0, 0x20, 0, 0x41, 23, 0x6a, 0x0b]),
    ]),
  );
}

function writeString(memory: WebAssembly.Memory, address: number, value: string) {
  const bytes = new TextEncoder().encode(`${value}\0`);
  new Uint8Array(memory.buffer, address, bytes.length).set(bytes);
}
function readString(memory: WebAssembly.Memory, address: number) {
  const bytes = new Uint8Array(memory.buffer);
  let end = address;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(address, end));
}

test("dladdr follows canonical plugin and main function slots across Wasm exports", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const mainInstance = new WebAssembly.Instance(mainModule());
  const table = mainInstance.exports.__indirect_function_table as WebAssembly.Table;
  new Uint8Array(memory.buffer, 3000, 12).set([
    0x31, 0x42, 0x53, 0x64, 0x75, 0x86, 0x97, 0xa8, 0xb9, 0xca, 0xdb, 0xec,
  ]);

  const descriptorAddress = 512;
  const pluginAddress = 1024;
  const pluginPathAddress = 600;
  const mainPathAddress = 700;
  new Uint8Array(memory.buffer, pluginAddress, picPlugin.length).set(picPlugin);
  writeString(memory, pluginPathAddress, "/plugins/dladdr-plugin.so");
  writeString(memory, mainPathAddress, "/bin/dladdr-runtime");
  const descriptor = new DataView(memory.buffer);
  let allocation = 8192;
  let pluginBase = 0;
  const exports = Object.assign({}, mainInstance.exports, {
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate: (size: number, alignment = 1) => {
      const align = Number(alignment);
      allocation = Math.ceil(allocation / align) * align;
      const result = allocation;
      allocation += Number(size);
      if (Number(alignment) === 16) pluginBase = result;
      return allocation < memory.buffer.byteLength ? result : 0;
    },
    __wasm_dlopen_deallocate: () => {},
    __wasm_dlopen_read: () => {
      descriptor.setBigUint64(descriptorAddress, BigInt(pluginAddress), true);
      descriptor.setBigUint64(descriptorAddress + 8, BigInt(picPlugin.length), true);
      descriptor.setBigUint64(descriptorAddress + 16, 1n, true);
      descriptor.setBigUint64(descriptorAddress + 24, 2n, true);
      descriptor.setBigUint64(descriptorAddress + 32, 0n, true);
      return descriptorAddress;
    },
    __wasm_dlopen_read_release: () => {},
    __wasm_dlopen_origin: () => pluginPathAddress,
    __wasm_dlopen_fd: () => 3,
    __wasm_dlopen_library_path: () => 0,
    __wasm_dlopen_main_path: () => mainPathAddress,
  });
  const process = new ProcessDylink({
    main: { exports } as WebAssembly.Instance,
    memory,
    address: "i32",
    maximumPages: 1,
    tableType: { address: "i32", minimum: 4n, maximum: 128n },
    signatures: new Map([["dladdr_runtime_main_function", "[[127],[127]]"]]),
    isControlFlow: () => false,
    fatal(error) {
      throw error;
    },
    pinFile: () => 1,
    unpinFile: () => 0,
  });

  const pathAddress = 4000;
  writeString(memory, pathAddress, "/plugins/dladdr-plugin.so");
  const handle = process.open(pathAddress, 2);
  assert.notEqual(handle, 0);

  const addressInfo = (address: number) => {
    const infoAddress = 4200;
    assert.equal(process.address(address, infoAddress), 1);
    const view = new DataView(memory.buffer);
    return {
      filename: readString(memory, view.getUint32(infoAddress, true)),
      base: view.getUint32(infoAddress + 4, true),
      symbol: readString(memory, view.getUint32(infoAddress + 8, true)) || null,
      symbolAddress: view.getUint32(infoAddress + 12, true),
    };
  };
  const lookup = (scope: number, name: string) => {
    const nameAddress = 4400;
    writeString(memory, nameAddress, name);
    const address = process.symbol(scope, nameAddress);
    assert.notEqual(address, 0, `dlsym could not find ${name}`);
    if (typeof address !== "number") throw new TypeError("expected a wasm32 symbol address");
    return address;
  };

  const pluginFunctionPointer = lookup(Number(handle), "dladdr_plugin_function");
  assert.equal(
    (table.get(pluginFunctionPointer) as (value: number) => number)(5),
    22,
    "plugin function call still uses its table slot",
  );
  const pluginFunctionInfo = addressInfo(pluginFunctionPointer);
  assert.deepEqual(pluginFunctionInfo, {
    filename: "/plugins/dladdr-plugin.so",
    base: pluginBase,
    symbol: "dladdr_plugin_function",
    symbolAddress: pluginFunctionPointer,
  });

  const pluginGetterPointer = lookup(Number(handle), "dladdr_plugin_hidden_pointer");
  const pluginGetterInfo = addressInfo(pluginGetterPointer);
  assert.deepEqual(pluginGetterInfo, {
    filename: "/plugins/dladdr-plugin.so",
    base: pluginBase,
    symbol: "dladdr_plugin_hidden_pointer",
    symbolAddress: pluginGetterPointer,
  });
  const hiddenFunctionPointer = (table.get(pluginGetterPointer) as () => number)();
  assert.equal(
    (table.get(hiddenFunctionPointer) as (value: number) => number)(0x1234),
    0x1234 ^ 0x5a5a,
  );
  assert.deepEqual(addressInfo(hiddenFunctionPointer), {
    filename: "/plugins/dladdr-plugin.so",
    base: pluginBase,
    symbol: null,
    symbolAddress: 0,
  });

  const pluginDataPointer = lookup(Number(handle), "dladdr_plugin_data");
  assert.deepEqual(
    [...new Uint8Array(memory.buffer, pluginDataPointer, 16)],
    [
      0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe,
      0x0f,
    ],
  );
  const pluginDataInfo = addressInfo(pluginDataPointer);
  assert.deepEqual(pluginDataInfo, {
    filename: "/plugins/dladdr-plugin.so",
    base: pluginBase,
    symbol: "dladdr_plugin_data",
    symbolAddress: pluginDataPointer,
  });

  const mainFunctionPointer = lookup(0, "dladdr_runtime_main_function");
  assert.equal(
    (table.get(mainFunctionPointer) as (value: number) => number)(19),
    42,
    "main function call still uses its table slot",
  );
  assert.deepEqual(addressInfo(mainFunctionPointer), {
    filename: "/bin/dladdr-runtime",
    base: 0,
    symbol: "dladdr_runtime_main_function",
    symbolAddress: mainFunctionPointer,
  });
  const mainDataPointer = lookup(0, "dladdr_runtime_main_data");
  assert.deepEqual(
    [...new Uint8Array(memory.buffer, mainDataPointer, 12)],
    [0x31, 0x42, 0x53, 0x64, 0x75, 0x86, 0x97, 0xa8, 0xb9, 0xca, 0xdb, 0xec],
  );
  assert.deepEqual(addressInfo(mainDataPointer), {
    filename: "/bin/dladdr-runtime",
    base: 0,
    symbol: "dladdr_runtime_main_data",
    symbolAddress: mainDataPointer,
  });
});
