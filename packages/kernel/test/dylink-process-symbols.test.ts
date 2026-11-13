// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { ProcessDylink } from "../src/dylink_process.ts";
import { DylinkInitializationError } from "../src/dylink_linker.ts";
import { prepare_dylink_worker_publication } from "../src/dylink_process_worker.ts";

const u32 = (value: number) => {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
};
const s32 = (input: number) => {
  const bytes: number[] = [];
  let value = input | 0;
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && !(byte & 0x40)) || (value === -1 && !!(byte & 0x40));
    bytes.push(byte | (done ? 0 : 0x80));
    if (done) return bytes;
  }
};
const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
};
const section = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];
const custom = (name: string, payload: number[]) => section(0, [...text(name), ...payload]);
const functionBody = (instructions: number[]) => {
  const body = [0, ...instructions, 0x0b]; // no locals, then function body
  return [...u32(body.length), ...body];
};

type ExportSpec = { name: string; index: number; flags?: number };
type ModuleSpec = {
  needed?: string[];
  functionImports?: string[];
  globalImports?: { module: string; name: string }[];
  exports: ExportSpec[];
  functions: number[][];
};

function dynamicModule(spec: ModuleSpec) {
  const functionImports = spec.functionImports ?? [];
  const globalImports = spec.globalImports ?? [];
  const dylink = [
    ...section(1, [...u32(0), ...u32(0), ...u32(0), ...u32(0)]),
    ...section(2, [
      ...u32(spec.needed?.length ?? 0),
      ...(spec.needed ?? []).flatMap((name) => text(name)),
    ]),
    ...section(3, [
      ...u32(spec.exports.length),
      ...spec.exports.flatMap(({ name, flags = 0 }) => [...text(name), ...u32(flags)]),
    ]),
    ...section(4, [
      ...u32(functionImports.length + globalImports.length),
      ...functionImports.flatMap((name) => [...text("env"), ...text(name), ...u32(0)]),
      ...globalImports.flatMap(({ module, name }) => [...text(module), ...text(name), ...u32(0)]),
    ]),
  ];
  const imports = [
    ...u32(functionImports.length + 4 + globalImports.length),
    ...functionImports.flatMap((name) => [...text("env"), ...text(name), 0, ...u32(0)]),
    ...text("env"),
    ...text("memory"),
    2,
    3, // shared memory with an explicit maximum
    ...u32(1),
    ...u32(4),
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(4),
    ...u32(4096),
    ...text("env"),
    ...text("__memory_base"),
    3,
    0x7f,
    0,
    ...text("env"),
    ...text("__table_base"),
    3,
    0x7f,
    0,
    ...globalImports.flatMap(({ module, name }) => [...text(module), ...text(name), 3, 0x7f, 1]),
  ];
  const exports = [
    ...u32(spec.exports.length),
    ...spec.exports.flatMap(({ name, index }) => [
      ...text(name),
      0,
      ...u32(functionImports.length + index),
    ]),
  ];
  const code = [
    ...u32(spec.functions.length),
    ...spec.functions.flatMap((body) => functionBody(body)),
  ];
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...custom("dylink.0", dylink),
    ...section(1, [1, 0x60, 0, 1, 0x7f]), // one [] -> i32 type
    ...section(2, imports),
    ...section(3, [spec.functions.length, ...spec.functions.flatMap(() => [0])]),
    ...section(7, exports),
    ...section(10, code),
  ]);
}

function mainModule(functionCount: number, tableMinimum = functionCount + 3) {
  const names = ["collision_strong", "collision_weak", "collision_got"];
  for (let index = 0; index < functionCount - 3; index++)
    names.push(`unused_export_${index.toString().padStart(4, "0")}`);
  const types = [...u32(1), 0x60, 0, 1, 0x7f];
  const functionTypes = [...u32(names.length), ...names.flatMap(() => [0])];
  const table = [1, 0x70, 1, ...u32(tableMinimum), ...u32(4096)];
  const global = [2, 0x7f, 1, 0x41, 0, 0x0b, 0x7f, 0, 0x41, ...s32(123), 0x0b];
  const exports = [
    ...u32(names.length + 4),
    ...text("__indirect_function_table"),
    1,
    0,
    ...text("__stack_pointer"),
    3,
    0,
    ...text("collision_data"),
    3,
    1,
    ...names.flatMap((name, index) => [...text(name), 0, ...u32(index)]),
    ...text("collision_alias"),
    0,
    ...u32(0),
  ];
  const elements = [
    1,
    0,
    0x41,
    3,
    0x0b,
    ...u32(names.length),
    ...names.flatMap((_, index) => u32(index)),
  ];
  const code = [
    ...u32(names.length),
    ...names.flatMap((_, index) =>
      functionBody([0x41, ...s32(index === 0 ? 7 : index === 1 ? 11 : index === 2 ? 21 : 0)]),
    ),
  ];
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, types),
    ...section(3, functionTypes),
    ...section(4, table),
    ...section(6, global),
    ...section(7, exports),
    ...section(9, elements),
    ...section(10, code),
  ]);
}

const modules = new Map([
  [
    "/plugins/root.so",
    dynamicModule({
      needed: ["libdep.so"],
      functionImports: ["collision_strong", "collision_weak", "late_symbol"],
      globalImports: [
        { module: "GOT.func", name: "collision_got" },
        { module: "GOT.mem", name: "collision_data" },
      ],
      exports: [
        { name: "invoke", index: 0 },
        { name: "call_late", index: 1 },
        { name: "read_got_function", index: 2 },
        { name: "read_got_data", index: 3 },
      ],
      functions: [
        [0x10, 0, 0x10, 1, 0x6a], // external strong + weak provider
        [0x10, 2], // deferred lazy provider
        [0x23, 2], // GOT.func collision_got
        [0x23, 3], // GOT.mem collision_data
      ],
    }),
  ],
  [
    "/usr/lib/libdep.so",
    dynamicModule({
      exports: [
        { name: "collision_strong", index: 0 },
        { name: "collision_weak", index: 1, flags: 1 },
      ],
      functions: [
        [0x41, ...s32(200)],
        [0x41, ...s32(300)],
      ],
    }),
  ],
  [
    "/plugins/liblate.so",
    dynamicModule({
      exports: [{ name: "late_symbol", index: 0 }],
      functions: [[0x41, ...s32(9)]],
    }),
  ],
  [
    "/plugins/root2.so",
    dynamicModule({
      needed: ["libdep.so"],
      exports: [{ name: "root2_entry", index: 0 }],
      functions: [[0x41, ...s32(44)]],
    }),
  ],
]);

function writeString(memory: WebAssembly.Memory, address: number, value: string) {
  new Uint8Array(memory.buffer, address, value.length + 1).set([
    ...new TextEncoder().encode(value),
    0,
  ]);
}

function readString(memory: WebAssembly.Memory, address: number) {
  const bytes = new Uint8Array(memory.buffer);
  let end = address;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(address, end));
}

function loaderCallbacks(memory: WebAssembly.Memory) {
  const descriptorAddress = 512;
  const fileAddress = 2048;
  const originAddress = 1024;
  const descriptor = new DataView(memory.buffer);
  let allocation = 16384;
  let currentPath = "";
  let descriptorTarget: string | undefined;
  let nextInode = 1n;
  const inodes = new Map<string, bigint>();
  const resolvedPath = (path: string) =>
    path === "/proc/self/fd/9" && descriptorTarget ? descriptorTarget : path;
  return {
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate(size: number, alignment = 1) {
      const aligned = Math.ceil(allocation / alignment) * alignment;
      const end = aligned + Number(size);
      if (end > memory.buffer.byteLength) return 0;
      allocation = end;
      return aligned;
    },
    __wasm_dlopen_deallocate: () => {},
    __wasm_dlopen_read(pathPointer: number) {
      currentPath = readString(memory, pathPointer);
      const identityPath = resolvedPath(currentPath);
      const bytes = modules.get(identityPath);
      descriptor.setBigUint64(descriptorAddress, BigInt(fileAddress), true);
      descriptor.setBigUint64(descriptorAddress + 16, 1n, true);
      if (!bytes) {
        descriptor.setBigUint64(descriptorAddress + 8, 0n, true);
        descriptor.setBigUint64(descriptorAddress + 24, 0n, true);
        descriptor.setBigUint64(descriptorAddress + 32, 2n, true);
        return descriptorAddress;
      }
      new Uint8Array(memory.buffer, fileAddress, bytes.length).set(bytes);
      descriptor.setBigUint64(descriptorAddress + 8, BigInt(bytes.length), true);
      let inode = inodes.get(identityPath);
      if (inode === undefined) {
        inode = nextInode++;
        inodes.set(identityPath, inode);
      }
      descriptor.setBigUint64(descriptorAddress + 24, inode, true);
      descriptor.setBigUint64(descriptorAddress + 32, 0n, true);
      return descriptorAddress;
    },
    __wasm_dlopen_read_release: () => {},
    __wasm_dlopen_origin() {
      writeString(memory, originAddress, currentPath);
      return originAddress;
    },
    __wasm_dlopen_fd: () => (modules.has(resolvedPath(currentPath)) ? 3 : -1),
    __wasm_dlopen_library_path: () => 0,
    __wasm_dlopen_main_path: () => 0,
    setDescriptorTarget(path: string) {
      descriptorTarget = path;
    },
  };
}

function processOptions(
  memory: WebAssembly.Memory,
  mainInstance: WebAssembly.Instance,
  callbacks: ReturnType<typeof loaderCallbacks>,
  signatures: ReadonlyMap<string, string>,
  privateExports: ReadonlySet<string>,
  replay?: ReturnType<ProcessDylink["exportWorkerSnapshot"]>,
  gates: {
    blocked?: () => boolean;
    queryBlocked?: () => boolean;
    postThread?: () => boolean;
    onPin?: () => void;
    onUnpin?: () => void;
  } = {},
) {
  const exports = Object.assign({}, mainInstance.exports, callbacks);
  let nextPin = 1;
  return {
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address: "i32" as const,
    maximumPages: 4,
    tableType: {
      address: "i32" as const,
      minimum: BigInt((exports.__indirect_function_table as WebAssembly.Table).length),
      maximum: 4096n,
    },
    signatures,
    privateExports,
    blocked: gates.blocked ?? (() => false),
    ...(gates.queryBlocked ? { queryBlocked: gates.queryBlocked } : {}),
    ...(gates.postThread ? { postThread: gates.postThread } : {}),
    isControlFlow: () => false,
    fatal(error: unknown): never {
      throw error;
    },
    pinFile: () => {
      gates.onPin?.();
      return nextPin++;
    },
    unpinFile: () => {
      gates.onUnpin?.();
      return 0;
    },
    ...(replay === undefined ? {} : { replay }),
  };
}

function publicationDraft(
  previous: ReturnType<ProcessDylink["exportWorkerSnapshot"]>,
  next: ReturnType<ProcessDylink["exportWorkerSnapshot"]>,
) {
  const tableSlots: [number, NonNullable<(typeof next.main.tableSlots)[number]>][] = [];
  for (let index = 0; index < next.main.tableSlots.length; index++) {
    const old = previous.main.tableSlots[index];
    const current = next.main.tableSlots[index];
    if ((old === null || old === undefined) && current) tableSlots.push([index, current]);
  }
  return {
    main: {
      handle: next.main.handle,
      lastMap: next.main.lastMap,
      cursor: next.main.cursor,
      tableLength: next.main.tableLength,
      functionSlots: next.main.functionSlots.slice(previous.main.functionSlots.length),
      tableSlots,
      addressNames: next.main.addressNames.slice(previous.main.addressNames.length),
    },
    files: next.files.slice(previous.files.length),
    groups: next.groups.slice(previous.groups.length),
    groupFunctionSlots: [],
    objectGroups: next.objectGroups.slice(previous.objectGroups.length),
    aliases: next.aliases.slice(previous.aliases.length),
    globalOrder: next.globalOrder.slice(previous.globalOrder.length),
    owners: next.owners.slice(previous.owners.length),
    ownerNames: next.ownerNames.slice(previous.ownerNames.length),
    nextOwner: next.nextOwner,
    symbols: next.symbols.slice(previous.symbols.length),
  };
}

function lookUpFunction(
  process: ProcessDylink,
  memory: WebAssembly.Memory,
  table: WebAssembly.Table,
  handle: number,
  name: string,
) {
  const nameAddress = 12000;
  writeString(memory, nameAddress, name);
  const address = process.symbol(handle, nameAddress);
  assert.notEqual(address, 0, `missing function ${name}`);
  return table.get(Number(address)) as CallableFunction;
}

function loaderError(process: ProcessDylink, memory: WebAssembly.Memory) {
  const address = 15000;
  process.error(address, 256);
  return readString(memory, address);
}

test("per-group dynamic snapshots retain only names in the full load graph", () => {
  const unusedMainExportCount = 2048;
  const functionCount = unusedMainExportCount + 3;
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const parentModule = new WebAssembly.Module(mainModule(functionCount));
  const parentMain = new WebAssembly.Instance(parentModule);
  const parentTable = parentMain.exports.__indirect_function_table as WebAssembly.Table;
  const callbacks = loaderCallbacks(memory);
  const privateExports = new Set(
    Object.keys(callbacks).filter((name) => name !== "__stack_pointer"),
  );
  const signatures = new Map<string, string>();
  for (let index = 0; index < functionCount; index++) {
    const name =
      index === 0
        ? "collision_strong"
        : index === 1
          ? "collision_weak"
          : index === 2
            ? "collision_got"
            : `unused_export_${(index - 3).toString().padStart(4, "0")}`;
    signatures.set(name, "[[],[127]]");
  }
  signatures.set("collision_alias", "[[],[127]]");

  const parent = new ProcessDylink(
    processOptions(memory, parentMain, callbacks, signatures, privateExports),
  );
  const pathAddress = 256;
  writeString(memory, pathAddress, "/plugins/root.so");
  const rootHandle = parent.open(pathAddress, 1); // RTLD_LAZY
  assert.notEqual(rootHandle, 0, loaderError(parent, memory));
  const invoke = lookUpFunction(parent, memory, parentTable, Number(rootHandle), "invoke");
  assert.equal(invoke(), 18, "main symbols preempt strong and weak dependency definitions");
  const readGotFunction = lookUpFunction(
    parent,
    memory,
    parentTable,
    Number(rootHandle),
    "read_got_function",
  );
  assert.equal(
    (parentTable.get(Number(readGotFunction())) as CallableFunction)(),
    21,
    "GOT.func imports retain the main process binding",
  );
  const readGotData = lookUpFunction(
    parent,
    memory,
    parentTable,
    Number(rootHandle),
    "read_got_data",
  );
  assert.equal(readGotData(), 123, "GOT.mem imports retain the main process address");
  const callLate = lookUpFunction(parent, memory, parentTable, Number(rootHandle), "call_late");

  writeString(memory, pathAddress, "/plugins/liblate.so");
  const providerHandle = parent.open(pathAddress, 2 | 256); // RTLD_NOW | RTLD_GLOBAL
  assert.notEqual(providerHandle, 0);
  assert.equal(callLate(), 9, "publishing a later provider binds the original lazy import");

  writeString(memory, pathAddress, "/plugins/root2.so");
  assert.notEqual(parent.open(pathAddress, 2), 0);
  const snapshot = parent.exportWorkerSnapshot();
  assert.deepEqual(
    snapshot.main.tableSlots[3],
    {
      moduleKey: "main",
      exportAlias: "collision_alias",
    },
    "a table slot keeps the lexically selected alias when one function has several exports",
  );
  const fileByKey = new Map(snapshot.files.map((file) => [file.key, file]));
  const groupFor = (path: string) => {
    const group = snapshot.groups.find((candidate) =>
      candidate.order.some((key) => fileByKey.get(key)?.path === path),
    );
    assert.ok(group, `missing snapshot group for ${path}`);
    return group;
  };
  const namesFor = (path: string) =>
    groupFor(path)
      .externalSymbols.map(([name]) => name)
      .sort();
  assert.deepEqual(namesFor("/plugins/root.so"), [
    "collision_data",
    "collision_got",
    "collision_strong",
    "collision_weak",
  ]);
  assert.deepEqual(
    namesFor("/plugins/root2.so"),
    ["collision_strong", "collision_weak"],
    "an already-loaded dependency contributes exports to the new graph projection",
  );
  assert.equal(
    groupFor("/plugins/root.so").externalSymbols.length,
    4,
    `the group excludes ${unusedMainExportCount} unrelated process symbols`,
  );
  assert.ok(
    snapshot.symbols.length > unusedMainExportCount,
    `the process-wide lookup scope remains intact for later queries (${snapshot.symbols.length} symbols)`,
  );

  const workerTableLength = Number(snapshot.main.tableLength);
  const workerMain = new WebAssembly.Instance(
    new WebAssembly.Module(mainModule(functionCount, workerTableLength)),
  );
  const workerCallbacks = loaderCallbacks(memory);
  const worker = new ProcessDylink(
    processOptions(memory, workerMain, workerCallbacks, signatures, privateExports, snapshot),
  );
  const workerTable = workerMain.exports.__indirect_function_table as WebAssembly.Table;
  const replayedInvoke = lookUpFunction(worker, memory, workerTable, Number(rootHandle), "invoke");
  assert.equal(replayedInvoke(), 18, "replay keeps the original external binding");
  const replayedGotFunction = lookUpFunction(
    worker,
    memory,
    workerTable,
    Number(rootHandle),
    "read_got_function",
  );
  assert.equal(
    (workerTable.get(Number(replayedGotFunction())) as CallableFunction)(),
    21,
    "replay restores GOT.func bindings",
  );
  const replayedGotData = lookUpFunction(
    worker,
    memory,
    workerTable,
    Number(rootHandle),
    "read_got_data",
  );
  assert.equal(replayedGotData(), 123, "replay restores GOT.mem bindings");
  const replayedCallLate = lookUpFunction(
    worker,
    memory,
    workerTable,
    Number(rootHandle),
    "call_late",
  );
  assert.equal(replayedCallLate(), 9, "replay rebinds the lazy import from the final global scope");
  const root2Handle = snapshot.objectGroups.find(
    ([key]) => fileByKey.get(key)?.path === "/plugins/root2.so",
  )?.[1].handle;
  assert.notEqual(root2Handle, undefined);
  assert.equal(
    lookUpFunction(worker, memory, workerTable, Number(root2Handle), "root2_entry")(),
    44,
    "replay keeps a group that reused the dependency instance",
  );
});

test("worker snapshot establishes a stable main link_map before replay", () => {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const main = new WebAssembly.Instance(new WebAssembly.Module(mainModule(3)));
  const callbacks = loaderCallbacks(memory);
  const privateExports = new Set(
    Object.keys(callbacks).filter((name) => name !== "__stack_pointer"),
  );
  const signatures = new Map([
    ["collision_strong", "[[],[127]]"],
    ["collision_weak", "[[],[127]]"],
    ["collision_got", "[[],[127]]"],
    ["collision_alias", "[[],[127]]"],
  ]);
  const process = new ProcessDylink(
    processOptions(memory, main, callbacks, signatures, privateExports),
  );

  const snapshot = process.exportWorkerSnapshot();
  assert.notEqual(snapshot.main.handle, 0n, "snapshot must carry the process main handle");
  assert.equal(
    process.open(0, 2),
    Number(snapshot.main.handle),
    "parent and replayed Workers use the same lazily requested dlopen(NULL) handle",
  );
});

test("replayed Worker prepares and commits only an appended dynamic group", () => {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const functionCount = 3;
  const mainSignatures = new Map([
    ["collision_strong", "[[],[127]]"],
    ["collision_weak", "[[],[127]]"],
    ["collision_got", "[[],[127]]"],
    ["collision_alias", "[[],[127]]"],
  ]);
  const main = new WebAssembly.Instance(new WebAssembly.Module(mainModule(functionCount)));
  const callbacks = loaderCallbacks(memory);
  const privateExports = new Set(
    Object.keys(callbacks).filter((name) => name !== "__stack_pointer"),
  );
  const parent = new ProcessDylink(
    processOptions(memory, main, callbacks, mainSignatures, privateExports),
  );
  const base = parent.exportWorkerSnapshot();

  const workerMain = new WebAssembly.Instance(
    new WebAssembly.Module(mainModule(functionCount, base.main.tableLength)),
  );
  const workerCallbacks = loaderCallbacks(memory);
  const worker = new ProcessDylink({
    ...processOptions(memory, workerMain, workerCallbacks, mainSignatures, privateExports, base),
    workerPublicationState: { processIdentity: "extension-test", generation: 0, snapshot: base },
  });

  writeString(memory, 256, "/plugins/liblate.so");
  assert.notEqual(parent.open(256, 2 | 256), 0, "parent publishes the new provider");
  const next = parent.exportWorkerSnapshot();
  const publication = prepare_dylink_worker_publication(
    base,
    "extension-test",
    0,
    publicationDraft(base, next),
  );
  const candidate = worker.prepareWorkerExtension(publication);

  writeString(memory, 12000, "late_symbol");
  assert.equal(worker.symbol(0, 12000), 0, "candidate preparation does not publish the new symbol");

  const table = workerMain.exports.__indirect_function_table as WebAssembly.Table;
  const appendedSlot = Number(base.main.tableLength);
  const receipt = worker.commitWorkerExtensionProvisional(candidate);
  assert.notEqual(
    table.get(appendedSlot),
    null,
    "provisional commit installs its staged table slot",
  );
  assert.equal(
    worker.symbol(0, 12000),
    0,
    "loader queries are blocked until publication is finalized",
  );
  assert.equal(
    worker.open(256, 2),
    0,
    "loader graph changes are blocked while a receipt is pending",
  );
  assert.throws(
    () => parent.finalizeWorkerExtension(receipt),
    /belongs to another process/,
    "a receipt cannot be finalized by another ProcessDylink",
  );
  worker.rollbackWorkerExtension(receipt);
  assert.equal(table.get(appendedSlot), null, "rollback restores the previously empty table slot");
  assert.equal(worker.symbol(0, 12000), 0, "rollback removes the provisional symbol");
  assert.throws(() => worker.rollbackWorkerExtension(receipt), /already consumed/);

  assert.equal(worker.error(14000, 128), 0);
  const priorDlerror = readString(memory, 14000);
  const finalizedCandidate = worker.prepareWorkerExtension(publication);
  const finalizedReceipt = worker.commitWorkerExtensionProvisional(finalizedCandidate);
  assert.equal(worker.symbol(0, 12000), 0, "queries remain blocked until the receipt is finalized");
  const state = worker.finalizeWorkerExtension(finalizedReceipt);
  assert.equal(state.generation, 1);
  assert.equal(state.processIdentity, "extension-test");
  assert.throws(() => worker.finalizeWorkerExtension(finalizedReceipt), /already consumed/);
  assert.equal(worker.error(14000, 128), 0);
  assert.equal(
    readString(memory, 14000),
    priorDlerror,
    "finalize restores the prior dlerror state",
  );

  const noOpPublication = prepare_dylink_worker_publication(
    state.snapshot,
    state.processIdentity,
    state.generation,
    publicationDraft(state.snapshot, state.snapshot),
  );
  const noOpCandidate = worker.prepareWorkerExtension(noOpPublication);
  assert.equal(
    worker.commitWorkerExtension(noOpCandidate).generation,
    2,
    "legacy commit API finalizes its receipt",
  );

  const symbol = worker.symbol(0, 12000);
  assert.notEqual(symbol, 0, "commit publishes the new global symbol");
  assert.equal((table.get(Number(symbol)) as CallableFunction)(), 9);
  assert.throws(() => worker.commitWorkerExtension(finalizedCandidate), /already consumed/);
});

test("a committed Worker receipt treats graph divergence as fatal", () => {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const functionCount = 3;
  const mainSignatures = new Map([
    ["collision_strong", "[[],[127]]"],
    ["collision_weak", "[[],[127]]"],
    ["collision_got", "[[],[127]]"],
    ["collision_alias", "[[],[127]]"],
  ]);
  const main = new WebAssembly.Instance(new WebAssembly.Module(mainModule(functionCount)));
  const callbacks = loaderCallbacks(memory);
  const privateExports = new Set(
    Object.keys(callbacks).filter((name) => name !== "__stack_pointer"),
  );
  const parent = new ProcessDylink(
    processOptions(memory, main, callbacks, mainSignatures, privateExports),
  );
  const base = parent.exportWorkerSnapshot();

  const workerMain = new WebAssembly.Instance(
    new WebAssembly.Module(mainModule(functionCount, base.main.tableLength)),
  );
  const workerCallbacks = loaderCallbacks(memory);
  const worker = new ProcessDylink({
    ...processOptions(memory, workerMain, workerCallbacks, mainSignatures, privateExports, base),
    workerPublicationState: {
      processIdentity: "fatal-receipt-test",
      generation: 0,
      snapshot: base,
    },
  });

  writeString(memory, 256, "/plugins/liblate.so");
  assert.notEqual(parent.open(256, 2 | 256), 0);
  const next = parent.exportWorkerSnapshot();
  const publication = prepare_dylink_worker_publication(
    base,
    "fatal-receipt-test",
    0,
    publicationDraft(base, next),
  );
  const candidate = worker.prepareWorkerExtension(publication);
  const receipt = worker.commitWorkerExtensionProvisional(candidate);
  const table = workerMain.exports.__indirect_function_table as WebAssembly.Table;
  const appendedSlot = Number(base.main.tableLength);
  table.set(appendedSlot, null);

  assert.throws(
    () => worker.rollbackWorkerExtension(receipt),
    (error) => error instanceof DylinkInitializationError,
    "divergent shared table state makes the process fatal instead of recoverable",
  );
});

test("threaded loader queries and reopens only already published objects", () => {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const main = new WebAssembly.Instance(new WebAssembly.Module(mainModule(3)));
  const table = main.exports.__indirect_function_table as WebAssembly.Table;
  const callbacks = loaderCallbacks(memory);
  const signatures = new Map([
    ["collision_strong", "[[],[127]]"],
    ["collision_weak", "[[],[127]]"],
    ["collision_got", "[[],[127]]"],
    ["collision_alias", "[[],[127]]"],
  ]);
  const privateExports = new Set(
    Object.keys(callbacks).filter((name) => name !== "__stack_pointer"),
  );
  const gate = { postThread: false, vfork: false, livePins: 0 };
  const process = new ProcessDylink(
    processOptions(memory, main, callbacks, signatures, privateExports, undefined, {
      blocked: () => gate.postThread || gate.vfork,
      queryBlocked: () => gate.vfork,
      postThread: () => gate.postThread,
      onPin: () => gate.livePins++,
      onUnpin: () => gate.livePins--,
    }),
  );

  const pathAddress = 256;
  writeString(memory, pathAddress, "/plugins/root2.so");
  const handle = process.open(pathAddress, 2); // RTLD_NOW | RTLD_LOCAL
  assert.notEqual(handle, 0);
  gate.postThread = true;

  const mainHandle = process.open(0, 2);
  assert.notEqual(mainHandle, 0);
  assert.equal(process.open(0, 2), mainHandle, "dlopen(NULL) keeps a stable main handle");
  assert.equal(process.open(pathAddress, 2), handle, "RTLD_NOW reopens the existing local object");
  assert.equal(process.open(pathAddress, 1), handle, "RTLD_LAZY reopens the existing local object");
  assert.equal(process.open(pathAddress, 6), handle, "RTLD_NOLOAD returns the existing object");

  const functionAddress = process.symbol(
    handle,
    (() => {
      writeString(memory, 12000, "root2_entry");
      return 12000;
    })(),
  );
  assert.notEqual(functionAddress, 0, "dlsym remains available after thread creation");
  assert.equal(
    process.address(functionAddress, 13000),
    1,
    "dladdr remains available after thread creation",
  );
  assert.equal((table.get(Number(functionAddress)) as CallableFunction)(), 44);

  callbacks.setDescriptorTarget("/plugins/root2.so");
  writeString(memory, pathAddress, "/proc/self/fd/9");
  const loadedPinCount = gate.livePins;
  assert.equal(
    process.open(pathAddress, 2),
    handle,
    "descriptor reopen resolves the current inode before returning a stable object handle",
  );
  assert.equal(
    gate.livePins,
    loadedPinCount,
    "reopening an already loaded descriptor releases its duplicate pin",
  );
  callbacks.setDescriptorTarget("/plugins/root.so");
  assert.equal(
    process.open(pathAddress, 2),
    0,
    "a reused descriptor cannot alias another loaded name",
  );
  assert.equal(
    gate.livePins,
    loadedPinCount,
    "a refused descriptor reopen does not retain a new pin",
  );

  writeString(memory, pathAddress, "/plugins/root.so");
  assert.equal(process.open(pathAddress, 2), 0, "a first load is blocked after thread creation");
  assert.match(loaderError(process, memory), /after thread creation/);
  assert.equal(
    process.open(pathAddress, 2 | 256),
    0,
    "RTLD_GLOBAL promotion is blocked after thread creation",
  );
  assert.match(loaderError(process, memory), /after thread creation/);

  gate.vfork = true;
  writeString(memory, 12000, "root2_entry");
  assert.equal(process.symbol(handle, 12000), 0, "vfork still blocks symbol queries");
  assert.match(loaderError(process, memory), /vfork child/);
  assert.equal(process.open(0, 2), 0, "vfork still blocks dlopen(NULL)");
});
