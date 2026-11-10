// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  create_dylink_call_wrapper,
  create_dylink_tail_call_wrapper,
} from "../src/dylink_call_wrapper.ts";
import { ProcessDylink } from "../src/dylink_process.ts";
import {
  dynamic_tail_table_import,
  prepare_wasm_dynamic_tail_calls,
  read_wasm_dynamic_imports,
} from "../src/wasm_binary.ts";
import { link_dylink_graph } from "../src/dylink_linker.ts";

const header = [0, 97, 115, 109, 1, 0, 0, 0];
const text = (name: string) => {
  const bytes = [...new TextEncoder().encode(name)];
  return [...leb(bytes.length), ...bytes];
};
function leb(value: number) {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}
const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
const marker = section(0, [...text("linux.dylink.tail.v1"), 1]);

function module(
  code: number[],
  { marked = true, start = false, table64 = false, definedTable = false } = {},
) {
  const body = [0, ...code, 0x0b];
  return new Uint8Array([
    ...header,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...section(2, [
      1,
      ...text("env"),
      ...text("__indirect_function_table"),
      1,
      0x70,
      table64 ? 4 : 0,
      1,
    ]),
    ...section(3, [1, 0]),
    ...(definedTable ? section(4, [1, 0x70, 0, 1]) : []),
    ...section(7, [1, ...text("step"), 0, 0]),
    ...(start ? section(8, [0]) : []),
    ...section(9, [1, 0, table64 ? 0x42 : 0x41, 0, 0x0b, 1, 0]),
    ...section(10, [1, ...leb(body.length), ...body]),
    ...(marked ? marker : []),
  ]);
}

const tailLoop = [
  0x20, 0, 0x04, 0x7f, 0x20, 0, 0x41, 1, 0x6b, 0x41, 0, 0x13, 0, 0, 0x05, 0x41, 42, 0x0b,
];

test("marked modules reject defined tables before shifting their indices", () => {
  const bytes = module(tailLoop, { definedTable: true });
  new WebAssembly.Module(bytes);
  assert.throws(() => prepare_wasm_dynamic_tail_calls(bytes), /must not define a private table/);
});

function dynamicTailModule() {
  const dynamicInfo = section(0, [
    ...text("dylink.0"),
    ...section(1, [0, 0, 0, 0]),
    ...section(2, [0]),
  ]);
  const imports = section(2, [
    1,
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    0,
    1,
  ]);
  const body = [0, ...tailLoop, 0x0b];
  return new Uint8Array([
    ...header,
    ...dynamicInfo,
    ...section(0, [...text("linux.dylink.tail.v1"), 1]),
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...imports,
    ...section(3, [1, 0]),
    ...section(7, [1, ...text("step"), 0, 0]),
    ...section(10, [1, ...leb(body.length), ...body]),
  ]);
}

function dynamicProcessTailModule() {
  const dylink = section(0, [
    ...text("dylink.0"),
    ...section(1, [0, 0, 1, 0]),
    ...section(2, [0]),
    ...section(3, [1, ...text("step"), 0]),
  ]);
  const imports = section(2, [
    2,
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    4,
    20,
    ...text("env"),
    ...text("__table_base"),
    3,
    0x7f,
    0,
  ]);
  const code = [...tailLoop];
  code[10] = 4; // The loader places this module's function at table slot four.
  const body = [0, ...code, 0x0b];
  return new Uint8Array([
    ...header,
    ...dylink,
    ...section(0, [...text("linux.dylink.tail.v1"), 1]),
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...imports,
    ...section(3, [1, 0]),
    ...section(7, [1, ...text("step"), 0, 0]),
    ...section(9, [1, 2, 0, 0x23, 0, 0x0b, 0, 1, 0]),
    ...section(10, [1, ...leb(body.length), ...body]),
  ]);
}

function importedDirectTailCallModule() {
  return new Uint8Array([
    ...header,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...section(2, [
      2,
      ...text("env"),
      ...text("__indirect_function_table"),
      1,
      0x70,
      0,
      1,
      ...text("env"),
      ...text("external"),
      0,
      0,
    ]),
    ...section(3, [1, 0]),
    ...section(10, [1, 6, 0, 0x20, 0, 0x12, 0, 0x0b]),
    ...marker,
  ]);
}

test("marked indirect tail calls use the private table and preserve the canonical table", () => {
  const original = module(tailLoop);
  const prepared = prepare_wasm_dynamic_tail_calls(original);
  assert.equal(prepared.enabled, true);
  assert.equal(prepared.redirectedCalls, 1);
  assert.equal(prepared.tailTableRequired, true);
  assert.deepEqual(
    read_wasm_dynamic_imports(prepared.bytes).filter((entry) => entry.kind === "table"),
    [
      {
        module: "env",
        name: "__indirect_function_table",
        kind: "table",
        address: "i32",
        minimum: 1n,
        maximum: undefined,
      },
      {
        module: "env",
        name: dynamic_tail_table_import,
        kind: "table",
        address: "i32",
        minimum: 1n,
        maximum: undefined,
      },
    ],
  );

  const canonical = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const tail = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const instance = new WebAssembly.Instance(new WebAssembly.Module(prepared.bytes), {
    env: {
      __indirect_function_table: canonical,
      [dynamic_tail_table_import]: tail,
    },
  });
  const target = instance.exports.step as CallableFunction;
  assert.equal(canonical.get(0), target);
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 9);
  tail.set(0, create_dylink_tail_call_wrapper("[[127],[127]]", target, context, 17));
  const entry = create_dylink_call_wrapper("[[127],[127]]", target, context, 22);

  assert.equal(entry(100_000), 42);
  assert.equal(context.value, 9);
});

test("unmarked modules keep their original table call encoding and imports", () => {
  const original = module(tailLoop, { marked: false });
  const prepared = prepare_wasm_dynamic_tail_calls(original);
  assert.equal(prepared.enabled, false);
  assert.equal(prepared.redirectedCalls, 0);
  assert.equal(prepared.tailTableRequired, false);
  assert.deepEqual(prepared.bytes, original);
  assert.equal(
    read_wasm_dynamic_imports(prepared.bytes).filter((entry) => entry.kind === "table").length,
    1,
  );
});

test("the marked transform preserves a table64 index space", () => {
  const table64Loop = [...tailLoop];
  table64Loop[9] = 0x42; // table64 indexes are i64 stack values.
  const prepared = prepare_wasm_dynamic_tail_calls(module(table64Loop, { table64: true }));
  const imports = read_wasm_dynamic_imports(prepared.bytes).filter(
    (entry) => entry.kind === "table",
  );
  assert.equal(imports.length, 2);
  assert.ok(imports.every((entry) => entry.kind === "table" && entry.address === "i64"));

  const descriptor = {
    element: "anyfunc" as const,
    address: "i64",
    initial: 1n,
  } as unknown as WebAssembly.TableDescriptor;
  const canonical = new WebAssembly.Table(descriptor);
  const tail = new WebAssembly.Table(descriptor);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(prepared.bytes), {
    env: {
      __indirect_function_table: canonical,
      [dynamic_tail_table_import]: tail,
    },
  });
  const target = instance.exports.step as CallableFunction;
  const context = new WebAssembly.Global({ value: "i32", mutable: true }, 9);
  (tail.set as unknown as (index: bigint, value: CallableFunction) => void)(
    0n,
    create_dylink_tail_call_wrapper("[[127],[127]]", target, context, 17),
  );

  assert.equal(target(100_000), 42);
});

test("marked modules reject Wasm start and unknown instruction prefixes", () => {
  assert.throws(
    () => prepare_wasm_dynamic_tail_calls(module(tailLoop, { start: true })),
    /Wasm start section/,
  );
  assert.throws(
    () => prepare_wasm_dynamic_tail_calls(module([0xfb, 0, 0x01])),
    /unsupported dynamic tail-call instruction/,
  );
});

test("marked modules reject imported direct tail calls and return_call_ref", () => {
  assert.throws(
    () => prepare_wasm_dynamic_tail_calls(importedDirectTailCallModule()),
    /return_call to an imported function/,
  );
  assert.throws(
    () => prepare_wasm_dynamic_tail_calls(module([0x20, 0, 0xd2, 0, 0x15, 0])),
    /does not support return_call_ref/,
  );

  const localTailCall = module([0x20, 0, 0x12, 0]);
  assert.deepEqual(prepare_wasm_dynamic_tail_calls(localTailCall).bytes, localTailCall);
});

test("the dynamic linker binds the private ABI import to its separate process table", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  const canonical = new WebAssembly.Table({ element: "anyfunc", initial: 20, maximum: 20 });
  const tail = new WebAssembly.Table({ element: "anyfunc", initial: 20, maximum: 20 });
  const linked = link_dylink_graph({
    root: "root",
    files: new Map([["root", dynamicTailModule()]]),
    memory,
    table: canonical,
    tailTable: tail,
    memoryMaximumPages: 2n,
    tableMaximumElements: 20n,
    stack: new WebAssembly.Global({ value: "i32", mutable: true }, 60_000),
    memoryArena: { cursor: 128n, limit: 65_536n, address: "i32" },
    tableArena: { cursor: 3n, limit: 20n, address: "i32" },
  });
  const step = linked.instances.get("root")!.exports.step as CallableFunction;
  tail.set(0, step);

  assert.equal(step(100_000), 42);
});

test("ProcessDylink publishes canonical wrappers and tail wrappers at the same slot", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 4, maximum: 20 });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 60_000);
  const descriptorAddress = 512;
  const fileAddress = 1024;
  const originAddress = 600;
  const file = dynamicProcessTailModule();
  new Uint8Array(memory.buffer, fileAddress, file.length).set(file);
  new Uint8Array(memory.buffer, originAddress, 18).set(
    new TextEncoder().encode("/plugins/tail.so\0"),
  );
  let allocation = 8192;
  const exports = {
    __indirect_function_table: table,
    __stack_pointer: stack,
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate(size: number, alignment = 1) {
      allocation = Math.ceil(allocation / Number(alignment)) * Number(alignment);
      const result = allocation;
      allocation += Number(size);
      return allocation < memory.buffer.byteLength ? result : 0;
    },
    __wasm_dlopen_deallocate: () => {},
    __wasm_dlopen_read: () => {
      const view = new DataView(memory.buffer);
      view.setBigUint64(descriptorAddress, BigInt(fileAddress), true);
      view.setBigUint64(descriptorAddress + 8, BigInt(file.length), true);
      view.setBigUint64(descriptorAddress + 16, 1n, true);
      view.setBigUint64(descriptorAddress + 24, 2n, true);
      view.setBigUint64(descriptorAddress + 32, 0n, true);
      return descriptorAddress;
    },
    __wasm_dlopen_read_release: () => {},
    __wasm_dlopen_origin: () => originAddress,
    __wasm_dlopen_fd: () => 3,
    __wasm_dlopen_library_path: () => 0,
    __wasm_dlopen_main_path: () => 0,
  };
  const process = new ProcessDylink({
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address: "i32",
    maximumPages: 1,
    tableType: { address: "i32", minimum: 4n, maximum: 20n },
    signatures: new Map(),
    isControlFlow: () => false,
    fatal(error) {
      throw error;
    },
    pinFile: () => 1,
    unpinFile: () => 0,
  });
  const pathAddress = 4096;
  const nameAddress = 4200;
  new Uint8Array(memory.buffer, pathAddress, 18).set(
    new TextEncoder().encode("/plugins/tail.so\0"),
  );
  new Uint8Array(memory.buffer, nameAddress, 5).set(new TextEncoder().encode("step\0"));

  const handle = process.open(pathAddress, 2);
  assert.notEqual(handle, 0);
  const pointer = process.symbol(handle, nameAddress);
  assert.equal(pointer, 4);
  assert.equal((table.get(Number(pointer)) as CallableFunction)(100_000), 42);
});
