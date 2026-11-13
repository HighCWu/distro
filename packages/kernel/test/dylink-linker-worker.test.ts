// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { link_dylink_graph } from "../src/dylink_linker.ts";

const u32 = (value: number) => {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
};
const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
};
const section = (id: number, bytes: number[]) => [id, ...u32(bytes.length), ...bytes];

/** Minimal dylink module with an active data segment, element segment, start and ctor. */
function dylinkModule(
  needed: string[] = [],
  withTls = false,
  withAlias = false,
  importAnswer = false,
) {
  const info = section(0, [
    ...text("dylink.0"),
    1,
    ...u32(4),
    ...u32(16), // memory size
    0, // memory alignment
    1, // table size
    0, // table alignment
    ...(needed.length
      ? [
          2,
          ...u32(
            u32(needed.length).length +
              needed.reduce((size, name) => size + u32(name.length).length + name.length, 0),
          ),
          ...u32(needed.length),
          ...needed.flatMap(text),
        ]
      : []),
    ...(withTls ? [3, 7, 1, ...text("tls"), 0x80, 0x02] : []),
    ...(importAnswer ? [4, 13, 1, ...text("env"), ...text("answer"), 0] : []),
  ]);
  const types = section(1, [
    2,
    0x60,
    0,
    1,
    0x7f, // () -> i32
    0x60,
    0,
    0, // () -> ()
  ]);
  const memoryName = text("memory");
  const tableName = text("__indirect_function_table");
  const importGlobal = (name: string, mutable: number) => [
    ...text("env"),
    ...text(name),
    3,
    0x7f,
    mutable,
  ];
  const imports = section(2, [
    5 + Number(importAnswer),
    ...(importAnswer ? [...text("env"), ...text("answer"), 0, 0] : []),
    ...text("env"),
    ...memoryName,
    2,
    3,
    ...u32(1),
    ...u32(2), // shared memory min/max
    ...text("env"),
    ...tableName,
    1,
    0x70,
    1,
    ...u32(20),
    ...u32(20), // funcref table min/max
    ...importGlobal("__memory_base", 0),
    ...importGlobal("__table_base", 0),
    ...importGlobal("__stack_pointer", 1),
  ]);
  const functions = section(3, [4, 0, 1, 1, 0]);
  const ctorIndex = 1 + Number(importAnswer);
  const exports = section(7, [
    importAnswer ? 2 : 2 + Number(withAlias),
    ...(!importAnswer ? [...text("answer"), 0, 0] : []),
    ...text("__wasm_call_ctors"),
    0,
    ctorIndex,
    ...(withAlias ? [...text("answer_alias"), 0, 0] : []),
    ...(importAnswer ? [...text("call_answer"), 0, 4] : []),
  ]);
  const start = section(8, [2 + Number(importAnswer)]);
  const elements = section(9, [1, 0, 0x23, 1, 0x0b, 1, 0]);
  const increment = (amount: number) => [
    0, // no locals
    0x23,
    0, // global.get __memory_base
    0x23,
    0,
    0x2d,
    0,
    0, // i32.load8_u [memory_base]
    0x41,
    ...u32(amount),
    0x6a, // i32.add
    0x3a,
    0,
    0, // i32.store8 [memory_base]
    0x0b,
  ];
  const codeBodies = [
    [0, 0x41, 42, 0x0b], // answer() -> 42
    increment(1), // ctor increments byte at memory_base
    increment(10), // start increments byte at memory_base
    [0, 0x10, 0, 0x0b], // call_answer() calls the imported answer
  ];
  const code = section(10, [4, ...codeBodies.flatMap((body) => [...u32(body.length), ...body])]);
  const data = section(11, [1, 0, 0x23, 0, 0x0b, 1, 5]);
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...info,
    ...types,
    ...imports,
    ...functions,
    ...exports,
    ...start,
    ...elements,
    ...code,
    ...data,
  ]);
}

function setup(files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  return {
    root: "root",
    files,
    memory,
    table: new WebAssembly.Table({ element: "anyfunc", initial: 20, maximum: 20 }),
    memoryMaximumPages: 2n,
    tableMaximumElements: 20n,
    stack: new WebAssembly.Global({ value: "i32", mutable: true }, 60000),
    memoryArena: { cursor: 128n, limit: 256n, address: "i32" as const },
    tableArena: { cursor: 3n, limit: 20n, address: "i32" as const },
  };
}

test("Worker replay restores fixed placements and function slots without replaying data or constructors", () => {
  const files = new Map([["root", dylinkModule([], false, true)]]);
  const first = setup(files);
  const parent = link_dylink_graph(first);
  parent.initialize();
  assert.equal(parent.lookup("answer")!.address, 3n);
  const memory = new Uint8Array(first.memory.buffer);
  assert.equal(memory[128], 16, "active data, start and constructor ran on initial load");

  memory[128] = 77;
  const second = setup(files);
  // The Worker receives the same shared memory and a private table.
  const workerMemory = first.memory;
  const tailTable = new WebAssembly.Table({ element: "anyfunc", initial: 20, maximum: 20 });
  const worker = link_dylink_graph({
    ...second,
    memory: workerMemory,
    tailTable,
    replay: {
      placements: new Map([["root", { base: 128n, tableBase: 3n }]]),
      functionSlots: new Map([["root", new Map([["answer_alias", 3n]])]]),
    },
  });

  assert.equal(worker.records.get("root")!.base, 128n);
  assert.equal(worker.records.get("root")!.tableBase, 3n);
  assert.equal(worker.records.get("root")!.initialization?.state, "done");
  assert.equal(worker.lookup("answer")!.address, 3n);
  assert.equal(typeof worker.instances.get("root")!.exports.answer, "function");
  assert.equal((second.table.get(3) as CallableFunction)(), 42);
  assert.equal(tailTable.get(3), second.table.get(3));
  assert.equal(workerMemory.buffer instanceof SharedArrayBuffer, true);
  assert.equal(new Uint8Array(workerMemory.buffer)[128], 77, "replay preserves shared data");
  worker.initialize();
  assert.equal(new Uint8Array(workerMemory.buffer)[128], 77, "replay skips start and constructors");

  const reused = link_dylink_graph({
    ...second,
    memory: workerMemory,
    tailTable,
    replay: {
      placements: new Map([["root", { base: 128n, tableBase: 3n }]]),
      functionSlots: new Map([["root", new Map([["answer_alias", 3n]])]]),
    },
    reuse: worker.records,
  });
  assert.equal(reused.lookup("answer")!.address, 3n);
  assert.equal(typeof second.table.get(3), "function");
  assert.equal(new Uint8Array(workerMemory.buffer)[128], 77, "reuse preserves worker-shared data");
});

test("Worker replay rejects missing slots and overlapping or out-of-arena placements", () => {
  const files = new Map([
    ["root", dylinkModule(["dep"])],
    ["dep", dylinkModule()],
  ]);
  const base = setup(files);
  const slots = new Map([
    ["root", new Map([["answer", 3n]])],
    ["dep", new Map([["answer", 4n]])],
  ]);
  assert.throws(
    () =>
      link_dylink_graph({
        ...base,
        replay: {
          placements: new Map([
            ["root", { base: 128n, tableBase: 3n }],
            ["dep", { base: 128n, tableBase: 3n }],
          ]),
          functionSlots: slots,
        },
      }),
    /overlapping replay placement/,
  );
  const single = setup(new Map([["root", dylinkModule()]]));
  assert.throws(
    () =>
      link_dylink_graph({
        ...single,
        replay: {
          placements: new Map([["root", { base: 248n, tableBase: 3n }]]),
          functionSlots: new Map(),
        },
      }),
    /invalid replay memory placement/,
  );

  const missingSlot = link_dylink_graph({
    ...single,
    replay: {
      placements: new Map([["root", { base: 128n, tableBase: 3n }]]),
      functionSlots: new Map(),
    },
  });
  assert.throws(() => missingSlot.lookup("answer"), /missing from the Worker replay snapshot/);

  const tls = setup(new Map([["root", dylinkModule([], true)]]));
  assert.throws(
    () =>
      link_dylink_graph({
        ...tls,
        replay: {
          placements: new Map([["root", { base: 128n, tableBase: 3n }]]),
          functionSlots: new Map(),
        },
      }),
    /dynamic TLS is not supported during Worker replay/,
  );
});

test("Worker replay resolves an exported alias to its snapshotted function slot", () => {
  const options = setup(
    new Map([
      ["root", dylinkModule(["dep"], false, false, true)],
      ["dep", dylinkModule([], false, true)],
    ]),
  );
  const memory = new Uint8Array(options.memory.buffer);
  memory[128] = 77;
  memory[144] = 88;
  const linked = link_dylink_graph({
    ...options,
    replay: {
      placements: new Map([
        ["dep", { base: 128n, tableBase: 3n }],
        ["root", { base: 144n, tableBase: 4n }],
      ]),
      functionSlots: new Map([["dep", new Map([["answer_alias", 3n]])]]),
    },
  });

  assert.equal((linked.instances.get("root")!.exports.call_answer as CallableFunction)(), 42);
  assert.equal(typeof options.table.get(3), "function");
  assert.equal(memory[128], 77);
  assert.equal(memory[144], 88);
});
