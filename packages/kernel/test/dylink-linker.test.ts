// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { DylinkInitializationError, link_dylink_graph } from "../src/dylink_linker.ts";
import { read_wasm_dynamic_imports } from "../src/wasm_binary.ts";

const text = (name: string) => [name.length, ...new TextEncoder().encode(name)];
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
const info = section(1, [4, 0, 0, 0]);
function binary(
  options: {
    needed?: string[];
    extra?: number[];
    imports?: number[];
    trap?: "start" | "ctor";
    privateMemory?: boolean;
    exportName?: string;
    result64?: boolean;
    functionImports?: number;
    reexport?: boolean;
    callImport?: boolean;
    startCall?: boolean;
  } = {},
) {
  const metadata = [
    ...info,
    ...section(2, [options.needed?.length ?? 0, ...(options.needed ?? []).flatMap(text)]),
    ...(options.extra ?? []),
  ];
  const body = options.trap
    ? [0, 0, 11]
    : options.callImport
      ? [0, 0x10, 0, 11]
      : [0, options.result64 ? 0x42 : 0x41, 42, 11];
  const parts = [
    section(0, [...text("dylink.0"), ...metadata]),
    section(1, [
      options.startCall ? 2 : 1,
      0x60,
      0,
      ...(options.trap === "start" ? [0] : [1, options.result64 ? 0x7e : 0x7f]),
      ...(options.startCall ? [0x60, 0, 0] : []),
    ]),
    ...(options.imports ? [section(2, options.imports)] : []),
    section(3, options.startCall ? [2, 0, 1] : [1, 0]),
    ...(options.privateMemory ? [section(5, [1, 0, 1])] : []),
    section(7, [
      1,
      ...text(options.trap === "ctor" ? "__wasm_call_ctors" : (options.exportName ?? "answer")),
      0,
      options.reexport ? 0 : (options.functionImports ?? 0),
    ]),
    ...(options.trap === "start" ? [section(8, [0])] : []),
    ...(options.startCall ? [section(8, [(options.functionImports ?? 0) + 1])] : []),
    section(10, [
      options.startCall ? 2 : 1,
      body.length,
      ...body,
      ...(options.startCall ? [11, 0, 0x10, 0, 0x41, 42, 0x47, 0x04, 0x40, 0, 0x0b, 0x0b] : []),
    ]),
  ];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...parts.flat()]);
}
function setup(files = new Map([["root", binary()]])) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
  new Uint8Array(memory.buffer).fill(0x5a);
  return {
    root: "root",
    files,
    memory,
    table: new WebAssembly.Table({ element: "anyfunc", initial: 20, maximum: 20 }),
    memoryMaximumPages: 2n,
    tableMaximumElements: 20n,
    stack: new WebAssembly.Global({ value: "i32", mutable: true }, 60000),
    memoryArena: { cursor: 128n, limit: 65536n, address: "i32" as const },
    tableArena: { cursor: 3n, limit: 20n, address: "i32" as const },
  };
}

test("dependency graph deduplicates diamonds and zeroes only allocated data", () => {
  const options = setup(
    new Map([
      ["root", binary({ needed: ["left", "right"] })],
      ["left", binary({ needed: ["leaf"] })],
      ["right", binary({ needed: ["leaf"] })],
      ["leaf", binary()],
    ]),
  );
  const linked = link_dylink_graph(options);
  assert.deepEqual(linked.order, ["leaf", "left", "right", "root"]);
  assert.equal(linked.instances.size, 4);
  assert.equal((linked.instances.get("root")!.exports.answer as CallableFunction)(), 42);
  assert.deepEqual(
    [...new Uint8Array(options.memory.buffer, 127, 18)],
    [0x5a, ...Array(16).fill(0), 0x5a],
  );
  linked.initialize();
  assert.throws(() => linked.initialize(), /cannot be retried/);
});

test("cycles reuse module records with a single initialization schedule", () => {
  for (const files of [
    new Map([["root", binary({ needed: ["root"] })]]),
    new Map([
      ["root", binary({ needed: ["other"] })],
      ["other", binary({ needed: ["root"] })],
    ]),
  ]) {
    const linked = link_dylink_graph(setup(files));
    assert.deepEqual(linked.order, files.size === 1 ? ["root"] : ["other", "root"]);
    assert.equal(linked.instances.size, files.size);
    linked.initialize();
    assert.throws(() => linked.initialize(), /cannot be retried/);
  }
});

test("missing dependencies, TLS, extensions, private memory and missing symbols fail before mutation", () => {
  const unresolved = [1, ...text("env"), ...text("missing"), 0, 0];
  const cases = [
    new Map([["root", binary({ needed: ["absent"] })]]),
    new Map([["root", binary({ extra: section(3, [1, ...text("tls"), 0x80, 2]) })]]),
    new Map([["root", binary({ extra: section(99, []) })]]),
    new Map([["root", binary({ privateMemory: true })]]),
    new Map([["root", binary({ imports: unresolved, functionImports: 1 })]]),
  ];
  for (const files of cases) {
    const options = setup(files);
    const before = new Uint8Array(options.memory.buffer).slice();
    assert.throws(
      () => link_dylink_graph(options),
      (error: unknown) => error instanceof Error && !(error instanceof DylinkInitializationError),
    );
    assert.deepEqual(new Uint8Array(options.memory.buffer), before);
    for (let index = 0; index < options.table.length; index++)
      assert.equal(options.table.get(index), null);
  }
});

test("forwarded imports cannot hide incompatible Wasm function signatures", () => {
  const imports = [1, ...text("env"), ...text("external"), 0, 0];
  const options = setup(
    new Map([
      ["root", binary({ needed: ["provider"], imports, functionImports: 1 })],
      ["provider", binary({ exportName: "external", result64: true })],
    ]),
  );
  const before = new Uint8Array(options.memory.buffer).slice();
  assert.throws(() => link_dylink_graph(options), /signature mismatch/);
  assert.deepEqual(new Uint8Array(options.memory.buffer), before);
  const reexport = binary({ imports, functionImports: 1, reexport: true });
  assert.throws(() => link_dylink_graph(setup(new Map([["root", reexport]]))), /re-exports/);
});

test("later starts can use a forward edge as soon as its provider is instantiated", () => {
  const imports = (name: string) => [1, ...text("env"), ...text(name), 0, 0];
  const linked = link_dylink_graph(
    setup(
      new Map([
        [
          "root",
          binary({
            needed: ["left", "provider"],
            imports: imports("left_answer"),
            functionImports: 1,
            startCall: true,
          }),
        ],
        [
          "left",
          binary({
            needed: ["root"],
            imports: imports("external"),
            functionImports: 1,
            callImport: true,
            exportName: "left_answer",
          }),
        ],
        ["provider", binary({ exportName: "external" })],
      ]),
    ),
  );
  assert.deepEqual(linked.order, ["left", "provider", "root"]);
  linked.initialize();
});

test("constructor and start traps are irreversible errors, and constructors cannot be retried", () => {
  assert.throws(
    () => link_dylink_graph(setup(new Map([["root", binary({ trap: "start" })]]))),
    DylinkInitializationError,
  );
  const linked = link_dylink_graph(setup(new Map([["root", binary({ trap: "ctor" })]])));
  assert.throws(
    () => linked.initialize(),
    (error: unknown) =>
      error instanceof DylinkInitializationError && error.cause instanceof WebAssembly.RuntimeError,
  );
  assert.throws(() => linked.initialize(), /cannot be retried/);
});

test("incompatible hidden resource maxima reject before data initialization", () => {
  const imports = [1, ...text("env"), ...text("memory"), 2, 3, 1, 1];
  const options = setup(new Map([["root", binary({ imports })]]));
  const before = new Uint8Array(options.memory.buffer).slice();
  assert.throws(() => link_dylink_graph(options), /memory maximum/);
  assert.deepEqual(new Uint8Array(options.memory.buffer), before);
});

test("main/global bindings supply direct functions while handle lookup remains local", () => {
  const imports = [1, ...text("env"), ...text("external"), 0, 0];
  const options = setup(
    new Map([["root", binary({ imports, functionImports: 1, callImport: true })]]),
  );
  const value = () => 7;
  const linked = link_dylink_graph({
    ...options,
    externalSymbols: new Map([
      ["external", { value, signature: "[[],[127]]" }],
      ["main_only", { value, signature: "[[],[127]]" }],
    ]),
  });
  linked.initialize();
  assert.equal((linked.instances.get("root")!.exports.answer as CallableFunction)(), 7);
  assert.equal((linked.lookup("answer")!.value as CallableFunction)(), 7);
  assert.equal(linked.lookup("main_only"), undefined);
});

test("an exit/exec control transfer escapes a constructor without being relabeled a trap", () => {
  const imports = [1, ...text("env"), ...text("control"), 0, 0];
  const options = setup(
    new Map([
      [
        "root",
        binary({ exportName: "__wasm_call_ctors", imports, functionImports: 1, callImport: true }),
      ],
    ]),
  );
  const control = Symbol("process control transfer");
  const linked = link_dylink_graph({
    ...options,
    externalSymbols: new Map([
      [
        "control",
        {
          value: () => {
            throw control;
          },
          signature: "[[],[127]]",
        },
      ],
    ]),
    isControlFlow: (error) => error === control,
  });
  assert.throws(
    () => linked.initialize(),
    (error: unknown) => error === control,
  );
  assert.throws(() => linked.initialize(), /cannot be retried/);
});

test("dynamic import types retain memory64, table32 and independent integer globals", () => {
  const entries = [
    ...text("env"),
    ...text("memory"),
    2,
    7,
    1,
    2,
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    1,
    20,
    ...text("env"),
    ...text("__memory_base"),
    3,
    0x7e,
    0,
    ...text("env"),
    ...text("__table_base32"),
    3,
    0x7f,
    0,
  ];
  const bytes = binary({ imports: [4, ...entries] });
  assert.deepEqual(read_wasm_dynamic_imports(bytes), [
    {
      module: "env",
      name: "memory",
      kind: "memory",
      type: { address: "i64", minimum: 1n, maximum: 2n, shared: true },
    },
    {
      module: "env",
      name: "__indirect_function_table",
      kind: "table",
      address: "i32",
      minimum: 1n,
      maximum: 20n,
    },
    { module: "env", name: "__memory_base", kind: "global", value: "i64", mutable: false },
    { module: "env", name: "__table_base32", kind: "global", value: "i32", mutable: false },
  ]);
  const privateTable = new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(4, [1, 0x70, 0, 1]),
  ]);
  assert.throws(() => read_wasm_dynamic_imports(privateTable), /private table/);
});
