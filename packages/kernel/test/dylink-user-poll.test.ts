// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { link_dylink_graph } from "../src/dylink_linker.ts";

type Address = "i32" | "i64";
const leb = (value: number | bigint) => {
  let remaining = BigInt(value);
  const bytes: number[] = [];
  do {
    const byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 0x80 : 0));
  } while (remaining);
  return bytes;
};
const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
};
const section = (id: number, payload: number[]) => [id, ...leb(payload.length), ...payload];
const tableMarker = new WebAssembly.Instance(
  new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 0, 0]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...text("marker"), 0, 0]),
      ...section(10, [1, 2, 0, 0x0b]),
    ]),
  ),
).exports.marker as CallableFunction;

function pollModule(
  address: Address,
  {
    checkpointModules = ["linux_user_poll_v1", "linux_user_poll_v2"],
    checkpointName = "checkpoint",
    resultType = 0x7f,
    globalModule = "linux_user_poll_v2",
    globalName = "thread_pointer",
    globalType = address === "i64" ? 0x7e : 0x7f,
    globalMutable = true,
    withGlobal = true,
  }: {
    checkpointModules?: string[];
    checkpointName?: string;
    resultType?: number;
    globalModule?: string;
    globalName?: string;
    globalType?: number;
    globalMutable?: boolean;
    withGlobal?: boolean;
  } = {},
): Uint8Array<ArrayBuffer> {
  const memoryFlags = address === "i64" ? 7 : 3;
  const tableFlags = address === "i64" ? 5 : 1;
  const imports = [
    2 + checkpointModules.length + Number(withGlobal),
    ...text("env"),
    ...text("memory"),
    2,
    memoryFlags,
    ...leb(1),
    ...leb(2),
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    tableFlags,
    ...leb(4),
    ...leb(20),
    ...checkpointModules.flatMap((module) => [...text(module), ...text(checkpointName), 0, 0]),
    ...(withGlobal
      ? [...text(globalModule), ...text(globalName), 3, globalType, Number(globalMutable)]
      : []),
  ];
  const type = [1, 0x60, 0, 1, resultType];
  const functions = [checkpointModules.length, ...checkpointModules.map(() => 0)];
  const exports = [
    checkpointModules.length + Number(withGlobal),
    ...checkpointModules.flatMap((_, index) => [
      ...text(`call_${index}`),
      0,
      checkpointModules.length + index,
    ]),
    ...(withGlobal ? [...text("thread_pointer_export"), 3, 0] : []),
  ];
  const bodies = [
    checkpointModules.length,
    ...checkpointModules.flatMap((_, index) => [4, 0, 0x10, ...leb(index), 0x0b]),
  ];
  const dylinkInfo = section(1, [4, 0, 0, 0]);
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(0, [...text("dylink.0"), ...dylinkInfo]),
    ...section(1, type),
    ...section(2, imports),
    ...section(3, functions),
    ...section(7, exports),
    ...section(10, bodies),
  ]);
}

function setup(address: Address, moduleBytes: Uint8Array<ArrayBuffer>) {
  const memoryDescriptor =
    address === "i64"
      ? ({
          initial: 1n,
          maximum: 2n,
          shared: true,
          address: "i64",
        } as unknown as WebAssembly.MemoryDescriptor)
      : { initial: 1, maximum: 2, shared: true };
  const memory = new WebAssembly.Memory(memoryDescriptor);
  new Uint8Array(memory.buffer).fill(0x5a);
  const tableDescriptor: WebAssembly.TableDescriptor =
    address === "i64"
      ? ({
          element: "anyfunc",
          address: "i64",
          initial: 20n,
          maximum: 20n,
        } as unknown as WebAssembly.TableDescriptor)
      : { element: "anyfunc", initial: 20, maximum: 20 };
  const table = new WebAssembly.Table(tableDescriptor);
  const threadPointer = new WebAssembly.Global(
    { value: address, mutable: true },
    address === "i64" ? 0x1234n : 0x1234,
  );
  const calls = { v1: 0, v2: 0 };
  const hostFunctions = new Map<string, ReadonlyMap<string, CallableFunction>>([
    ["linux_user_poll_v1", new Map([["checkpoint", () => ++calls.v1]])],
    ["linux_user_poll_v2", new Map([["checkpoint", () => ++calls.v2]])],
  ]);
  const hostGlobals = new Map([
    ["linux_user_poll_v2", new Map([["thread_pointer", threadPointer]])],
  ]);
  const options = {
    root: "side",
    files: new Map<string, Uint8Array<ArrayBuffer>>([["side", moduleBytes]]),
    memory,
    table,
    memoryMaximumPages: 2n,
    tableMaximumElements: 20n,
    stack: new WebAssembly.Global({ value: "i32", mutable: true }, 60000),
    memoryArena: { cursor: 128n, limit: 65536n, address },
    tableArena: { cursor: 3n, limit: 20n, address },
    hostFunctions,
    hostGlobals,
  };
  return { options, memory, table, threadPointer, calls };
}

for (const address of ["i32", "i64"] as const) {
  test(`${address}: dynamic side-module checkpoints share the root providers and TLS global`, () => {
    const state = setup(address, pollModule(address));
    const originalThreadPointer = state.threadPointer.value;
    const linked = link_dylink_graph(state.options);
    const instance = linked.instances.get("side")!;
    assert.equal((instance.exports.call_0 as CallableFunction)(), 1);
    assert.equal((instance.exports.call_1 as CallableFunction)(), 1);
    assert.equal(state.calls.v1, 1);
    assert.equal(state.calls.v2, 1);
    assert.equal(instance.exports.thread_pointer_export, state.threadPointer);
    assert.equal(
      state.threadPointer.value,
      originalThreadPointer,
      "poll binding must not publish TP",
    );
  });

  test(`${address}: invalid poll imports fail before side-module memory or table changes`, () => {
    const invalidModules = [
      ["wrong checkpoint result", pollModule(address, { resultType: 0x7e })],
      ["unknown checkpoint import", pollModule(address, { checkpointName: "other" })],
      [
        "wrong thread pointer width",
        pollModule(address, { globalType: address === "i64" ? 0x7f : 0x7e }),
      ],
      ["immutable thread pointer", pollModule(address, { globalMutable: false })],
      ["unsupported poll global", pollModule(address, { globalName: "not_thread_pointer" })],
      ["wrong poll global namespace", pollModule(address, { globalModule: "linux_user_poll_v1" })],
    ] as const;

    for (const [label, bytes] of invalidModules) {
      const state = setup(address, bytes);
      const beforeMemory = new Uint8Array(state.memory.buffer).slice();
      const index = address === "i64" ? 3n : 3;
      const set = state.table.set as unknown as (
        index: number | bigint,
        value: CallableFunction,
      ) => void;
      const get = state.table.get as unknown as (index: number | bigint) => CallableFunction | null;
      set.call(state.table, index, tableMarker);
      const beforeTable = get.call(state.table, index);
      assert.throws(
        () => link_dylink_graph(state.options),
        (error: unknown) => error instanceof Error,
        label,
      );
      assert.deepEqual(new Uint8Array(state.memory.buffer), beforeMemory, label);
      assert.equal(get.call(state.table, index), beforeTable, label);
    }
  });

  test(`${address}: side-module checkpoints remain unavailable without a root v2 provider`, () => {
    const state = setup(address, pollModule(address));
    const beforeMemory = new Uint8Array(state.memory.buffer).slice();
    const options = { ...state.options, hostFunctions: undefined, hostGlobals: undefined };
    assert.throws(() => link_dylink_graph(options), /unresolved dynamic function/);
    assert.deepEqual(new Uint8Array(state.memory.buffer), beforeMemory);
  });

  test(`${address}: a wrongly typed host TLS global is rejected before mutation`, () => {
    const state = setup(address, pollModule(address));
    const beforeMemory = new Uint8Array(state.memory.buffer).slice();
    const wrongWidth = new WebAssembly.Global(
      { value: address === "i64" ? "i32" : "i64", mutable: true },
      address === "i64" ? 0x1234 : 0x1234n,
    );
    const options = {
      ...state.options,
      hostGlobals: new Map([["linux_user_poll_v2", new Map([["thread_pointer", wrongWidth]])]]),
    };
    assert.throws(
      () => link_dylink_graph(options),
      /incompatible dynamic user poll thread pointer/,
    );
    assert.deepEqual(new Uint8Array(state.memory.buffer), beforeMemory);
  });
}

test("linker rejects host globals outside the v2 thread pointer capability", () => {
  const state = setup("i32", pollModule("i32"));
  const options = {
    ...state.options,
    hostGlobals: new Map([
      ["linux_user_poll_v2", new Map([["other_global", state.threadPointer]])],
    ]),
  };
  assert.throws(() => link_dylink_graph(options), /unsupported dynamic host global/);
});
