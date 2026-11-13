// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { prepare_dylink_worker_module } from "../src/dylink_worker_module.ts";

const header = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];

function u32(value: number) {
  const bytes: number[] = [];
  do {
    const part = value & 0x7f;
    value >>>= 7;
    bytes.push(part | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
}

function section(id: number, payload: number[]) {
  return [id, ...u32(payload.length), ...payload];
}

function name(value: string) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
}

function body(bytes: number[]) {
  return [...u32(bytes.length), ...bytes];
}

function workerModule() {
  const initData = (destination: number, dataIndex: number, length: number) => [
    0, // locals
    0x41,
    destination,
    0x41,
    0,
    0x41,
    length,
    0xfc,
    8,
    ...u32(dataIndex),
    0, // memory.init dataidx, memidx 0
    0xfc,
    9,
    ...u32(dataIndex), // data.drop dataidx
    0x0b,
  ];

  return new Uint8Array(
    [
      ...header,
      section(1, [1, 0x60, 0, 0]), // one () -> () type
      section(2, [
        1,
        ...name("env"),
        ...name("memory"),
        2,
        3,
        1,
        2, // shared memory, min 1, max 2 pages
      ]),
      section(3, [4, 0, 0, 0, 0]), // start + three memory.init functions
      section(4, [1, 0x70, 0, 1]), // one funcref table
      section(7, [
        3,
        ...name("init_data0"),
        0,
        1,
        ...name("init_data1"),
        0,
        2,
        ...name("table"),
        1,
        0,
      ]),
      section(8, [0]), // this start writes 0x41 to shared memory and must be removed
      section(9, [1, 0, 0x41, 0, 0x0b, 1, 3]), // active element points at init_data2
      section(12, [3]), // data count stays 3 after active segments become passive
      section(10, [
        4,
        ...body([0, 0x41, 0, 0x41, 0x41, 0x36, 2, 0, 0x0b]), // start: i32.store 0x41 at 0
        ...body(initData(16, 0, 3)),
        ...body(initData(20, 1, 3)),
        ...body(initData(24, 2, 5)),
      ]),
      section(11, [
        3,
        0,
        0x41,
        0,
        0x0b,
        3,
        0x6f,
        0x6e,
        0x65, // active, implicit memory 0, "one"
        2,
        0,
        0x41,
        4,
        0x0b,
        3,
        0x74,
        0x77,
        0x6f, // active, explicit memory 0, "two"
        1,
        5,
        0x74,
        0x68,
        0x72,
        0x65,
        0x65, // already passive, "three"
      ]),
    ].flat(),
  );
}

function activeElementModule(flags: 0 | 2 | 4 | 6) {
  const element =
    flags === 0
      ? [1, 0, 0x23, 0, 0x0b, 1, 0]
      : flags === 2
        ? [1, 2, 0, 0x23, 0, 0x0b, 0, 1, 0]
        : flags === 4
          ? [1, 4, 0x23, 0, 0x0b, 1, 0xd2, 0, 0x0b]
          : [1, 6, 0, 0x23, 0, 0x0b, 0x70, 1, 0xd2, 0, 0x0b];
  return new Uint8Array(
    [
      ...header,
      section(0, [
        ...name("dylink.0"),
        1,
        ...u32(4), // memory info subsection
        ...u32(0), // memory size
        ...u32(0), // memory alignment
        ...u32(4), // reserved table elements
        ...u32(0), // table alignment
      ]),
      section(1, [1, 0x60, 0, 0]), // () -> ()
      section(2, [
        2,
        ...name("env"),
        ...name("__indirect_function_table"),
        1,
        0x70,
        1,
        8,
        8,
        ...name("env"),
        ...name("__table_base"),
        3,
        0x7f,
        0,
      ]),
      section(3, [2, 0, 0]),
      section(7, [2, ...name("function"), 0, 0, ...name("try_table_init"), 0, 1]),
      section(9, element),
      section(10, [
        2,
        ...body([0, 0x0b]),
        ...body([0, 0x41, 0, 0x41, 0, 0x41, 1, 0xfc, 12, 0, 0, 0x0b]),
      ]),
    ].flat(),
  );
}

function sectionPayload(source: Uint8Array<ArrayBuffer>, wanted: number) {
  let offset = 8;
  while (offset < source.length) {
    const id = source[offset++]!;
    let length = 0;
    let shift = 0;
    while (true) {
      const byte = source[offset++]!;
      length |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    if (id === wanted) return source.slice(offset, offset + length);
    offset += length;
  }
  return undefined;
}

function instantiateElementModule(module: WebAssembly.Module, table: WebAssembly.Table) {
  return new WebAssembly.Instance(module, {
    env: {
      __indirect_function_table: table,
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 4),
    },
  });
}

test("publication mode declarativizes active function-index elements without touching the table", () => {
  for (const flags of [0, 2] as const) {
    const source = activeElementModule(flags);
    const originalModule = new WebAssembly.Module(source);
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 8, maximum: 8 });
    instantiateElementModule(originalModule, table);
    const originalSlotValue = table.get(4);
    assert.equal(
      typeof originalSlotValue,
      "function",
      `ordinary flag ${flags} initializes the table`,
    );

    const startupBytes = prepare_dylink_worker_module(source, "i32");
    assert.deepEqual(
      sectionPayload(startupBytes, 9),
      sectionPayload(source, 9),
      "default startup replay leaves elements intact",
    );

    const publicationBytes = prepare_dylink_worker_module(source, "i32", {
      deferTableWrites: true,
    });
    const publicationPayload = sectionPayload(publicationBytes, 9)!;
    assert.equal(publicationPayload[1], 3, `active flag ${flags} becomes declarative flag 3`);
    const publicationModule = new WebAssembly.Module(publicationBytes);
    const publicationInstance = instantiateElementModule(publicationModule, table);
    assert.equal(
      table.get(4),
      originalSlotValue,
      "publication preparation performs no active table write",
    );
    assert.throws(
      () => (publicationInstance.exports.try_table_init as () => void)(),
      WebAssembly.RuntimeError,
      "the declarative element segment is already dropped when the instance becomes visible",
    );
    assert.equal(table.get(4), originalSlotValue);
  }
});

test("publication mode preserves expression element type and ref.func declarations", () => {
  for (const flags of [4, 6] as const) {
    const source = activeElementModule(flags);
    const bytes = prepare_dylink_worker_module(source, "i32", { deferTableWrites: true });
    const payload = sectionPayload(bytes, 9)!;
    assert.equal(payload[1], 7, `active flag ${flags} becomes declarative flag 7`);
    assert.equal(payload[2], 0x70, "the original funcref segment type is retained");
    const module = new WebAssembly.Module(bytes);
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 8, maximum: 8 });
    const instance = instantiateElementModule(module, table);
    assert.equal(
      table.get(4),
      null,
      "declarative ref.func entries do not populate the imported table",
    );
    assert.equal(
      typeof instance.exports.function,
      "function",
      "the retained ref.func remains valid",
    );
    assert.throws(
      () => (instance.exports.try_table_init as () => void)(),
      WebAssembly.RuntimeError,
      "the declarative ref.func segment remains dropped",
    );
  }
});

test("reconstructed Worker preserves data indexes and elements without resetting shared memory or rerunning start", async () => {
  const source = workerModule();
  const original = source.slice();
  const prepared = prepare_dylink_worker_module(source);
  assert.deepEqual(source, original, "preparation must not modify the caller's bytes");
  assert.notEqual(prepared.buffer, source.buffer, "preparation returns a new byte buffer");
  const module = new WebAssembly.Module(prepared);

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  new Uint8Array(memory.buffer).fill(0x5a);
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  const bytes = new Uint8Array(memory.buffer);
  assert.deepEqual(
    [...bytes.slice(0, 8)],
    Array(8).fill(0x5a),
    "active data and start did not rewrite shared memory",
  );

  const table = instance.exports.table as WebAssembly.Table;
  const tableFunction = table.get(0) as (() => void) | null;
  assert.equal(typeof tableFunction, "function", "active element initialization remains intact");

  assert.throws(
    () => (instance.exports.init_data0 as () => void)(),
    WebAssembly.RuntimeError,
    "active segment 0 keeps its index but remains unavailable after original initialization",
  );
  assert.throws(
    () => (instance.exports.init_data1 as () => void)(),
    WebAssembly.RuntimeError,
    "active segment 1 keeps its index but remains unavailable after original initialization",
  );
  tableFunction!();
  assert.deepEqual(
    [...bytes.slice(24, 29)],
    [0x74, 0x68, 0x72, 0x65, 0x65],
    "passive data index 2 remains valid through the table",
  );
});

test("active data offsets support only i32.const, i64.const, and global.get", () => {
  const module = (expression: number[]) =>
    new Uint8Array([...header, ...section(11, [1, 0, ...expression, 0])]);
  assert.throws(
    () => prepare_dylink_worker_module(module([0x41, 0, 0x41, 1, 0x6a, 0x0b])),
    /active data offset expression/,
  );
  assert.doesNotThrow(() => prepare_dylink_worker_module(module([0x42, 0, 0x0b])));
  assert.doesNotThrow(() => prepare_dylink_worker_module(module([0x23, 0, 0x0b])));
});

test("active segments must target memory zero and defined mutable globals are rejected", () => {
  const nonzeroMemory = new Uint8Array([...header, ...section(11, [1, 2, 1, 0x41, 0, 0x0b, 0])]);
  assert.throws(() => prepare_dylink_worker_module(nonzeroMemory), /memory index 0/);

  const mutableGlobal = new Uint8Array([...header, ...section(6, [1, 0x7f, 1, 0x41, 0, 0x0b])]);
  assert.throws(() => prepare_dylink_worker_module(mutableGlobal), /defined mutable globals/);
});

test("mutable imported stack-pointer globals are not rejected", () => {
  const importedGlobal = new Uint8Array([
    ...header,
    ...section(2, [1, ...name("env"), ...name("__stack_pointer"), 3, 0x7f, 1]),
  ]);
  assert.deepEqual(prepare_dylink_worker_module(importedGlobal), importedGlobal);
});

test("section order, duplicate sections, truncated payloads, and overflowing LEBs are rejected", () => {
  assert.throws(
    () =>
      prepare_dylink_worker_module(
        new Uint8Array([...header, ...section(3, [0]), ...section(2, [0])]),
      ),
    /out of order/,
  );
  assert.throws(
    () =>
      prepare_dylink_worker_module(
        new Uint8Array([...header, ...section(1, [0]), ...section(1, [0])]),
      ),
    /duplicate core section/,
  );
  assert.throws(
    () => prepare_dylink_worker_module(new Uint8Array([...header, 11, 4, 1])),
    /section extends past its parent/,
  );
  assert.throws(
    () =>
      prepare_dylink_worker_module(new Uint8Array([...header, 11, 0x80, 0x80, 0x80, 0x80, 0x10])),
    /u32 LEB128 overflows/,
  );

  const overflowingOffset = section(11, [1, 0, 0x41, 0x80, 0x80, 0x80, 0x80, 0x10, 0x0b, 0]);
  assert.throws(
    () => prepare_dylink_worker_module(new Uint8Array([...header, ...overflowingOffset])),
    /s32 LEB128 overflows/,
  );
  const truncatedPayload = section(11, [1, 0, 0x41, 0, 0x0b, 4, 0xaa]);
  assert.throws(
    () => prepare_dylink_worker_module(new Uint8Array([...header, ...truncatedPayload])),
    /immediate extends past its section/,
  );
});
