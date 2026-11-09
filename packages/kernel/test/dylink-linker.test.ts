// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { DylinkInitializationError, link_dylink_graph } from "../src/dylink_linker.ts";
import { read_wasm_dynamic_imports } from "../src/wasm_binary.ts";
import { create_dylink_forwarder } from "../src/dylink_forwarder.ts";

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
    gotFunctionExport?: boolean;
    callImport?: boolean;
    startCall?: boolean;
    privateExport?: string;
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
      1 + Number(!!options.privateExport) + Number(!!options.gotFunctionExport),
      ...text(options.trap === "ctor" ? "__wasm_call_ctors" : (options.exportName ?? "answer")),
      0,
      options.reexport ? 0 : (options.functionImports ?? 0),
      ...(options.privateExport
        ? [...text(options.privateExport), 0, options.functionImports ?? 0]
        : []),
      ...(options.gotFunctionExport ? [...text("got_address"), 3, 0] : []),
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

test("execution hooks retain original public scope, own-object lookup and canonical wrapped pointers", () => {
  const options = setup(
    new Map([
      ["root", binary({ needed: ["dep"] })],
      ["dep", binary({ exportName: "dependency_only" })],
    ]),
  );
  const events: string[] = [];
  const wrapped = new Map<CallableFunction, CallableFunction>();
  const functionPointers = new Map<CallableFunction, bigint>();
  let active: string | undefined;
  const execution = {
    prepare(name: string) {
      events.push(`prepare:${name}`);
      return new WebAssembly.Module(
        binary({
          needed: name === "root" ? ["dep"] : [],
          exportName: name === "root" ? "answer" : "dependency_only",
          privateExport: "private_function_alias",
        }),
      );
    },
    instantiate(name: string, action: () => WebAssembly.Instance) {
      const previous = active;
      active = name;
      events.push(`instantiate:${name}`);
      try {
        return action();
      } finally {
        active = previous;
      }
    },
    register(name: string, instance: WebAssembly.Instance) {
      assert.equal(active, undefined);
      events.push(`register:${name}`);
      const fn = instance.exports.private_function_alias as CallableFunction;
      const privateTable = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
      privateTable.set(0, fn);
      const forward = create_dylink_forwarder("[[],[127]]", privateTable, "i32");
      wrapped.set(fn, forward.call);
      wrapped.set(forward.call, forward.call);
      const address = name === "root" ? 19n : 18n;
      functionPointers.set(fn, address);
      options.table.set(Number(address), fn);
    },
    callable(fn: CallableFunction) {
      return wrapped.get(fn) ?? fn;
    },
    settleTable() {
      events.push("settle");
      for (let index = 0; index < options.table.length; index++) {
        const fn = options.table.get(index) as CallableFunction | null;
        if (fn) options.table.set(index, wrapped.get(fn) ?? fn);
      }
    },
  };
  const linked = link_dylink_graph({
    ...options,
    execution,
    functionPointers,
    externalSymbols: new Map([["answer", { value: () => 7, signature: "[[],[127]]" }]]),
  });
  assert.deepEqual(events, [
    "prepare:root",
    "prepare:dep",
    "instantiate:dep",
    "register:dep",
    "settle",
    "instantiate:root",
    "register:root",
    "settle",
  ]);
  assert.equal(linked.layout.tableEnd, 5n, "private exports do not consume public pointer budget");
  assert.deepEqual(linked.names, ["answer", "dependency_only"]);
  assert.equal(linked.lookupOwn("root", "private_function_alias"), undefined);
  assert.equal(linked.lookupOwn("root", "dependency_only"), undefined);
  assert.equal(linked.lookupFrom("root", "dependency_only")!.address, 18n);
  const own = linked.lookupOwn("root", "answer")!;
  assert.equal((own.value as CallableFunction)(), 42, "own lookup ignores main/global preemption");
  assert.equal(own.address, 19n);
  const original = linked.instances.get("root")!.exports.answer as CallableFunction;
  assert.notEqual(own.value, original);
  assert.equal(functionPointers.get(original), 19n);
  assert.equal(functionPointers.get(own.value as CallableFunction), 19n);
  assert.equal(options.table.get(19), own.value);
  assert.throws(() => linked.lookupOwn("unknown", "answer"), /unknown dynamic object/);
  events.length = 0;
  const reused = link_dylink_graph({
    ...options,
    execution,
    functionPointers,
    reuse: linked.records,
  });
  assert.deepEqual(events, [], "resident modules retain their registered execution instance");
  assert.equal(reused.lookupOwn("root", "answer")!.value, own.value);
});

test("relocations and constructors use execution callables and settle successful table changes", () => {
  const options = setup(
    new Map([
      ["root", binary({ needed: ["reloc"], exportName: "__wasm_call_ctors" })],
      ["reloc", binary({ exportName: "__wasm_apply_data_relocs" })],
    ]),
  );
  const owners = new Map<CallableFunction, string>();
  const events: string[] = [];
  const linked = link_dylink_graph({
    ...options,
    execution: {
      prepare(_name, bytes) {
        return new WebAssembly.Module(bytes);
      },
      instantiate(name, action) {
        events.push(`instantiate:${name}`);
        return action();
      },
      register(name, instance) {
        for (const value of Object.values(instance.exports))
          if (typeof value === "function") owners.set(value, name);
      },
      callable(fn) {
        events.push(`call:${owners.get(fn)}`);
        return fn;
      },
      settleTable() {
        events.push("settle");
      },
    },
  });
  assert.deepEqual(events, [
    "instantiate:reloc",
    "settle",
    "instantiate:root",
    "settle",
    "call:reloc",
    "settle",
  ]);
  assert.equal(linked.lookupOwn("root", "__wasm_call_ctors"), undefined);
  events.length = 0;
  linked.initialize();
  assert.deepEqual(events, ["call:root", "settle"]);
});

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

test("reentrant groups share pending, running, completed and poisoned constructor states", () => {
  const ctor = (name: string, needed: string[] = []) =>
    binary({
      needed,
      imports: [1, ...text("env"), ...text(name), 0, 0],
      functionImports: 1,
      callImport: true,
      exportName: "__wasm_call_ctors",
    });
  const files = new Map([
    ["root", ctor("root_ctor", ["peer"])],
    ["peer", ctor("peer_ctor")],
  ]);
  const options = setup(files);
  const events: string[] = [];
  let outer: ReturnType<typeof link_dylink_graph>;
  const hostFunctions = new Map([
    [
      "env",
      new Map<string, CallableFunction>([
        [
          "root_ctor",
          () => {
            events.push("root");
            return 0;
          },
        ],
        [
          "peer_ctor",
          () => {
            events.push("peer enter");
            const nested = link_dylink_graph({ ...options, hostFunctions, reuse: outer.records });
            nested.ensureInitialized();
            nested.ensureInitialized();
            events.push("peer leave");
            return 0;
          },
        ],
      ]),
    ],
  ]);
  outer = link_dylink_graph({ ...options, hostFunctions });
  outer.initialize();
  outer.ensureInitialized();
  assert.deepEqual(
    events,
    ["peer enter", "root", "peer leave"],
    "running dependency is skipped, pending root runs once, outer traversal then skips it",
  );
  const scopedEvents: string[] = [];
  const scoped = link_dylink_graph({
    ...setup(files),
    hostFunctions: new Map([
      [
        "env",
        new Map([
          [
            "root_ctor",
            () => {
              scopedEvents.push("root");
              return 0;
            },
          ],
          [
            "peer_ctor",
            () => {
              scopedEvents.push("peer");
              return 0;
            },
          ],
        ]),
      ],
    ]),
  });
  scoped.ensureInitializedFrom("peer");
  assert.deepEqual(scopedEvents, ["peer"], "a dependency handle must not initialize its consumer");
  scoped.ensureInitialized();
  assert.deepEqual(scopedEvents, ["peer", "root"]);
  let calls = 0;
  const failingOptions = setup(new Map([["root", ctor("fail")]]));
  const failing = link_dylink_graph({
    ...failingOptions,
    hostFunctions: new Map([
      [
        "env",
        new Map([
          [
            "fail",
            () => {
              calls++;
              throw new Error("ctor failed");
            },
          ],
        ]),
      ],
    ]),
  });
  assert.throws(() => failing.ensureInitialized(), DylinkInitializationError);
  const reused = link_dylink_graph({
    ...failingOptions,
    reuse: failing.records,
    hostFunctions: new Map([
      [
        "env",
        new Map([
          [
            "fail",
            () => {
              calls++;
              return 0;
            },
          ],
        ]),
      ],
    ]),
  });
  assert.throws(() => reused.ensureInitialized(), DylinkInitializationError);
  assert.equal(calls, 1, "a failed constructor stays poisoned across reused groups");
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

  const aliasOptions = setup(
    new Map([
      ["root", binary({ needed: ["forwarder"], imports, functionImports: 1 })],
      [
        "forwarder",
        binary({
          needed: ["provider"],
          imports: [1, ...text("env"), ...text("external"), 0, 0],
          functionImports: 1,
          reexport: true,
          exportName: "alias",
        }),
      ],
      ["provider", binary({ exportName: "external", result64: true })],
    ]),
  );
  const aliasBefore = new Uint8Array(aliasOptions.memory.buffer).slice();
  assert.throws(() => link_dylink_graph(aliasOptions), /signature mismatch/);
  assert.deepEqual(new Uint8Array(aliasOptions.memory.buffer), aliasBefore);
});

test("function re-exports resolve direct calls, GOT.func and handle lookup to one provider", () => {
  const functionImport = (module: string, name: string) => [...text(module), ...text(name), 0, 0];
  const globalImport = (module: string, name: string) => [
    ...text(module),
    ...text(name),
    3,
    0x7f,
    1,
  ];
  const imports = [2, ...functionImport("env", "alias"), ...globalImport("GOT.func", "alias")];
  const files = new Map([
    [
      "root",
      binary({
        needed: ["forwarder"],
        imports,
        functionImports: 1,
        callImport: true,
        gotFunctionExport: true,
      }),
    ],
    [
      "forwarder",
      binary({
        needed: ["provider"],
        imports: [1, ...functionImport("env", "origin")],
        functionImports: 1,
        reexport: true,
        exportName: "alias",
      }),
    ],
    ["provider", binary({ exportName: "origin" })],
  ]);
  const options = setup(files);
  const linked = link_dylink_graph(options);
  linked.initialize();
  const provider = linked.lookupOwn("provider", "origin")!;
  const alias = linked.lookupOwn("forwarder", "alias")!;
  assert.equal(alias.value, provider.value);
  assert.equal(alias.address, provider.address);
  assert.equal(linked.lookup("alias")!.address, provider.address);
  assert.equal(linked.lookupFrom("root", "alias")!.address, provider.address);
  assert.equal((linked.instances.get("root")!.exports.answer as CallableFunction)(), 42);
  assert.equal(
    (linked.instances.get("root")!.exports.got_address as WebAssembly.Global).value,
    Number(provider.address),
  );
});

test("same-name, multi-hop re-exports honor main preemption and preserve the provider slot", () => {
  const functionImport = (name: string) => [1, ...text("env"), ...text(name), 0, 0];
  const files = new Map([
    [
      "root",
      binary({
        needed: ["top"],
        imports: functionImport("public_alias"),
        functionImports: 1,
        callImport: true,
      }),
    ],
    [
      "top",
      binary({
        needed: ["middle", "provider", "fallback"],
        imports: functionImport("middle_alias"),
        functionImports: 1,
        reexport: true,
        exportName: "public_alias",
      }),
    ],
    [
      "middle",
      binary({
        needed: ["provider"],
        imports: functionImport("origin"),
        functionImports: 1,
        reexport: true,
        exportName: "middle_alias",
      }),
    ],
    [
      "provider",
      binary({
        imports: functionImport("origin"),
        functionImports: 1,
        reexport: true,
        exportName: "origin",
      }),
    ],
  ]);
  // Add a concrete fallback after the provider's deliberately same-name alias.
  files.set("fallback", binary({ exportName: "origin" }));
  const local = link_dylink_graph(setup(files));
  const fallback = local.lookupOwn("fallback", "origin")!;
  const forwarded = local.lookupOwn("top", "public_alias")!;
  assert.equal(forwarded.value, fallback.value);
  assert.equal(forwarded.address, fallback.address);
  assert.equal((local.instances.get("root")!.exports.answer as CallableFunction)(), 42);

  const main = new WebAssembly.Instance(new WebAssembly.Module(binary())).exports
    .answer as CallableFunction;
  const linked = link_dylink_graph({
    ...setup(files),
    externalSymbols: new Map([["origin", { value: main, signature: "[[],[127]]" }]]),
  });
  linked.initialize();
  const alias = linked.lookupOwn("top", "public_alias")!;
  const rootImport = linked.lookup("public_alias")!;
  assert.equal(alias.value, main);
  assert.equal(alias.address, rootImport.address);
  assert.equal((linked.instances.get("root")!.exports.answer as CallableFunction)(), 42);
});

test("same-name alias cycles reach a later concrete provider", () => {
  const functionImport = (name: string) => [1, ...text("env"), ...text(name), 0, 0];
  const linked = link_dylink_graph(
    setup(
      new Map([
        [
          "root",
          binary({
            needed: ["first", "third"],
            imports: functionImport("shared"),
            functionImports: 1,
            callImport: true,
          }),
        ],
        [
          "first",
          binary({
            needed: ["second"],
            imports: functionImport("loop"),
            functionImports: 1,
            reexport: true,
            exportName: "shared",
          }),
        ],
        [
          "second",
          binary({
            imports: functionImport("shared"),
            functionImports: 1,
            reexport: true,
            exportName: "loop",
          }),
        ],
        [
          "third",
          binary({
            needed: ["provider"],
            imports: functionImport("provider_fn"),
            functionImports: 1,
            reexport: true,
            exportName: "shared",
          }),
        ],
        ["provider", binary({ exportName: "provider_fn" })],
      ]),
    ),
  );
  const provider = linked.lookupOwn("provider", "provider_fn")!;
  for (const [object, name] of [
    ["first", "shared"],
    ["second", "loop"],
    ["third", "shared"],
  ]) {
    const alias = linked.lookupOwn(object!, name!)!;
    assert.equal(alias.value, provider.value);
    assert.equal(alias.address, provider.address);
  }
  assert.equal((linked.instances.get("root")!.exports.answer as CallableFunction)(), 42);
});

test("re-export-only cycles fail before memory or table mutation", () => {
  const functionImport = (name: string) => [1, ...text("env"), ...text(name), 0, 0];
  const cyclic = new Map([
    [
      "root",
      binary({
        needed: ["peer"],
        imports: functionImport("peer_alias"),
        functionImports: 1,
        reexport: true,
        exportName: "root_alias",
      }),
    ],
    [
      "peer",
      binary({
        needed: ["root"],
        imports: functionImport("root_alias"),
        functionImports: 1,
        reexport: true,
        exportName: "peer_alias",
      }),
    ],
  ]);
  const missing = new Map([
    [
      "root",
      binary({
        imports: functionImport("not_provided"),
        functionImports: 1,
        reexport: true,
        exportName: "alias",
      }),
    ],
  ]);
  for (const files of [cyclic, missing]) {
    const options = setup(files);
    const before = new Uint8Array(options.memory.buffer).slice();
    assert.throws(() => link_dylink_graph(options), /unresolved dynamic re-export/);
    assert.deepEqual(new Uint8Array(options.memory.buffer), before);
    for (let index = 0; index < options.table.length; index++)
      assert.equal(options.table.get(index), null);
  }
});

test("host-only re-export providers are rejected before memory or table mutation", () => {
  const bytes = binary({
    imports: [1, ...text("env"), ...text("host_fn"), 0, 0],
    functionImports: 1,
    reexport: true,
    exportName: "alias",
  });
  const hostOptions = setup(new Map([["root", bytes]]));
  const hostFunctions = new Map([["env", new Map([["host_fn", () => 42]])]]);
  const before = new Uint8Array(hostOptions.memory.buffer).slice();
  assert.throws(
    () => link_dylink_graph({ ...hostOptions, hostFunctions }),
    /unsupported dynamic re-export host import/,
  );
  assert.deepEqual(new Uint8Array(hostOptions.memory.buffer), before);
  for (let index = 0; index < hostOptions.table.length; index++)
    assert.equal(hostOptions.table.get(index), null);

  const providerOptions = setup(
    new Map([
      [
        "root",
        binary({
          needed: ["provider"],
          imports: [1, ...text("env"), ...text("host_fn"), 0, 0],
          functionImports: 1,
          reexport: true,
          exportName: "alias",
        }),
      ],
      ["provider", binary({ exportName: "host_fn" })],
    ]),
  );
  const providerBefore = new Uint8Array(providerOptions.memory.buffer).slice();
  assert.throws(
    () => link_dylink_graph({ ...providerOptions, hostFunctions }),
    /unsupported dynamic re-export host import/,
  );
  assert.deepEqual(new Uint8Array(providerOptions.memory.buffer), providerBefore);
  for (let index = 0; index < providerOptions.table.length; index++)
    assert.equal(providerOptions.table.get(index), null);

  const mainOptions = setup(new Map([["root", bytes]]));
  const mainBefore = new Uint8Array(mainOptions.memory.buffer).slice();
  assert.throws(
    () =>
      link_dylink_graph({
        ...mainOptions,
        externalSymbols: new Map([["host_fn", { value: () => 42, signature: "[[],[127]]" }]]),
      }),
    /unsupported dynamic re-export host function/,
  );
  assert.deepEqual(new Uint8Array(mainOptions.memory.buffer), mainBefore);
  for (let index = 0; index < mainOptions.table.length; index++)
    assert.equal(mainOptions.table.get(index), null);
});

test("object handles use their own dependency scope and reserve distinct shadowed function pointers", () => {
  const linked = link_dylink_graph(
    setup(
      new Map([
        ["root", binary({ needed: ["dep"], exportName: "shadow" })],
        ["dep", binary({ exportName: "shadow" })],
      ]),
    ),
  );
  const root = linked.lookupFrom("root", "shadow")!;
  const dependency = linked.lookupFrom("dep", "shadow")!;
  assert.notEqual(root.value, dependency.value);
  assert.notEqual(root.address, dependency.address, "each provider has a canonical table slot");
  assert.equal(linked.lookupFrom("dep", "shadow")!.address, dependency.address);
  assert.deepEqual(linked.symbolNamesFrom("dep"), ["shadow"]);
  assert.throws(() => linked.lookupFrom("unknown", "shadow"), /unknown dynamic object/);
});

test("first-thread TLS requires explicit ownership, stays private and validates the initialized image", () => {
  // Layout-only fixture; actual C compiler TLS initialization is checked by
  // the small Clang module corpus and the booted process workload.
  const image = (base = 128, size = 4, alignment = 4, offset = 0, flags = 260) => {
    const signed = (value: number) => {
      const bytes: number[] = [];
      for (;;) {
        let byte = value & 127;
        value >>= 7;
        if ((value === 0 && !(byte & 64)) || (value === -1 && byte & 64)) {
          bytes.push(byte);
          return bytes;
        }
        bytes.push(byte | 128);
      }
    };
    return new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(0, [
        ...text("dylink.0"),
        ...section(1, [16, 2, 0, 0]),
        ...section(3, [1, ...text("private_tls"), (flags & 127) | 128, flags >> 7]),
      ]),
      ...section(6, [
        4,
        ...[base, size, alignment, offset].flatMap((value, index) => [
          0x7f,
          index === 0 ? 1 : 0,
          0x41,
          ...signed(value),
          0x0b,
        ]),
      ]),
      ...section(7, [
        4,
        ...["__tls_base", "__tls_size", "__tls_align", "private_tls"].flatMap((name, index) => [
          ...text(name),
          3,
          index,
        ]),
      ]),
    ]);
  };
  const ordinary = setup(new Map([["root", image()]]));
  const before = new Uint8Array(ordinary.memory.buffer).slice();
  assert.throws(() => link_dylink_graph(ordinary), /TLS/);
  assert.deepEqual(new Uint8Array(ordinary.memory.buffer), before);
  const local = { ...ordinary, initialThreadLocalTls: true };
  const linked = link_dylink_graph(local);
  linked.initialize();
  for (const name of ["private_tls", "__tls_base", "__tls_size", "__wasm_init_tls"])
    assert.equal(
      linked.lookup(name),
      undefined,
      "TLS implementation details stay out of data scope",
    );
  const publicTls = setup(new Map([["root", image(128, 4, 4, 0, 256)]]));
  assert.throws(() => link_dylink_graph({ ...publicTls, initialThreadLocalTls: true }), /TLS/);
  const importedTls = binary({ extra: section(4, [1, ...text("env"), ...text("tls"), 0x84, 2]) });
  assert.throws(
    () =>
      link_dylink_graph({
        ...setup(new Map([["root", importedTls]])),
        initialThreadLocalTls: true,
      }),
    /TLS/,
  );
  for (const bytes of [image(0), image(128, 32), image(128, 4, 3), image(128, 4, 4, 5)]) {
    assert.throws(
      () =>
        link_dylink_graph({ ...setup(new Map([["root", bytes]])), initialThreadLocalTls: true }),
      DylinkInitializationError,
      "a bad post-start TLS layout cannot masquerade as a recoverable dlopen error",
    );
  }
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
