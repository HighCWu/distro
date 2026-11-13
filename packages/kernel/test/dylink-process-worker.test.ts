// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { DylinkInitializationError } from "../src/dylink_linker.ts";
import { ProcessDylink, type DylinkWorkerOwnerRollback } from "../src/dylink_process.ts";
import { DylinkWorkerChannel } from "../src/dylink_worker_channel.ts";
import { DylinkWorkerReceiver } from "../src/dylink_worker_receiver.ts";
import { DylinkWorkerWriter } from "../src/dylink_worker_writer.ts";
import {
  apply_dylink_worker_publication,
  DylinkWorkerSnapshotError,
  prepare_dylink_worker_publication,
  prepare_dylink_worker_snapshot,
  validate_dylink_worker_snapshot,
  type DylinkWorkerSnapshot,
} from "../src/dylink_process_worker.ts";
import { create_dylink_worker_publication_delta } from "../src/dylink_worker_publication.ts";
import {
  inspect_dylink_worker_empty_tls_scaffold,
  inspect_dylink_worker_memory_initializer,
  prepare_dylink_worker_module,
} from "../src/dylink_worker_module.ts";

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

test("Worker module rewriting preserves a concrete ref.null heap type", () => {
  const bytes = new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(6, [1, 0x63, 0, 0, 0xd0, 0, 0x0b]),
    ...section(7, [1, ...text("reference"), 3, 0]),
  ]);
  new WebAssembly.Module(bytes);
  const rewritten = prepare_dylink_worker_module(bytes);
  assert.deepEqual(rewritten, bytes);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(rewritten));
  assert.equal((instance.exports.reference as WebAssembly.Global).value, null);
});

const u64 = (value: bigint) => {
  const bytes: number[] = [];
  do {
    const next = Number(value & 0x7fn);
    value >>= 7n;
    bytes.push(next | (value === 0n ? 0 : 0x80));
  } while (value !== 0n);
  return bytes;
};

function activeEmptyElementModule() {
  return new Uint8Array(
    [
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      section(0, [
        ...text("dylink.0"),
        1,
        ...u32(4), // memory info subsection
        ...u32(0), // memory size
        ...u32(0), // memory alignment
        ...u32(0), // table size
        ...u32(0), // table alignment
      ]),
      section(2, [
        2,
        ...text("env"),
        ...text("memory"),
        2,
        3, // shared memory with a maximum
        ...u32(1),
        ...u32(2),
        ...text("env"),
        ...text("__indirect_function_table"),
        1,
        0x70, // funcref table
        1, // minimum and maximum present
        ...u32(3),
        ...u32(3),
      ]),
      // One active table-zero segment with an empty function-index vector.
      // Flag 0 has no elemkind byte; only flag 2 carries that byte.
      section(9, [1, 0, 0x41, 0, 0x0b, 0]),
    ].flat(),
  );
}

function emptyTlsScaffoldModule(tlsSize = 0n, omitDrop = false, memoryFillValue = 0) {
  const initMemoryBody = [
    1,
    2,
    0x7e, // two i64 locals
    0x23,
    0,
    0x42,
    8,
    0x7c,
    0x21,
    0,
    0x02,
    0x40,
    0x02,
    0x40,
    0x02,
    0x40,
    0x20,
    0,
    0x41,
    0,
    0x41,
    1,
    0xfe,
    0x48,
    2,
    0,
    0x0e,
    2,
    0,
    1,
    2,
    0x0b,
    0x42,
    0,
    0x23,
    0,
    0x7c,
    0x41,
    0,
    0x41,
    4,
    0xfc,
    8,
    0,
    0,
    0x42,
    4,
    0x23,
    0,
    0x7c,
    0x41,
    memoryFillValue,
    0x42,
    4,
    0xfc,
    11,
    0,
    0x20,
    0,
    0x41,
    2,
    0xfe,
    0x17,
    2,
    0,
    0x20,
    0,
    0x41,
    0x7f,
    0xfe,
    0,
    2,
    0,
    0x1a,
    0x0c,
    1,
    0x0b,
    0x20,
    0,
    0x41,
    1,
    0x42,
    0x7f,
    0xfe,
    1,
    2,
    0,
    0x1a,
    0x0b,
    ...(omitDrop ? [] : [0xfc, 9, 0]),
    0x0b,
  ];
  return new Uint8Array(
    [
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      section(0, [
        ...text("dylink.0"),
        1,
        ...u32(4),
        ...u32(12), // .data, zero-fill region and the shared-memory init flag
        ...u32(2),
        ...u32(0),
        ...u32(0),
        6,
        ...u32(text("wasm64").length),
        ...text("wasm64"),
      ]),
      section(1, [1, 0x60, 0, 0]),
      section(2, [
        3,
        ...text("env"),
        ...text("memory"),
        2,
        7, // shared, maximum, memory64
        ...u64(1n),
        ...u64(2n),
        ...text("env"),
        ...text("__memory_base"),
        3,
        0x7e,
        0,
        ...text("env"),
        ...text("__table_base"),
        3,
        0x7e,
        0,
      ]),
      section(3, [2, 0, 0]),
      section(6, [
        4,
        0x7e,
        1,
        0x42,
        0,
        0x0b, // mutable __tls_base = 0
        0x7e,
        0,
        0x42,
        ...u64(tlsSize),
        0x0b, // immutable __tls_size
        0x7e,
        0,
        0x42,
        1,
        0x0b, // immutable __tls_align = 1
        0x7e,
        0,
        0x42,
        8,
        0x0b, // immutable __wasm_init_memory_flag = 8
      ]),
      section(7, [
        6,
        ...text("__tls_base"),
        3,
        2,
        ...text("__tls_size"),
        3,
        3,
        ...text("__tls_align"),
        3,
        4,
        ...text("__wasm_init_tls"),
        0,
        0,
        ...text("__wasm_init_memory"),
        0,
        1,
        ...text("__wasm_init_memory_flag"),
        3,
        5,
      ]),
      section(8, [1]),
      section(12, [1]),
      section(10, [
        2,
        2,
        0,
        0x0b, // empty __wasm_init_tls body
        ...u32(initMemoryBody.length),
        ...initMemoryBody,
      ]),
      section(11, [1, 1, 4, 19, 0, 0, 0]), // passive .data
    ].flat(),
  );
}

function snapshotWithModule(bytes: Uint8Array<ArrayBuffer>) {
  return {
    version: 1,
    address: "i64" as const,
    tableAddress: "i64" as const,
    main: {
      handle: 0n,
      lastMap: 0n,
      cursor: 3n,
      tableLength: 3,
      functionSlots: [],
      tableSlots: [null, null, null],
      addressNames: [],
    },
    files: [{ key: "root", path: "/root.so", bytes, pin: 1, dependencies: [] }],
    groups: [
      {
        id: 0,
        root: "root",
        handle: 1n,
        order: ["root"],
        lazyFunctions: [],
        placements: [["root", { base: 128n, tableBase: 3n }]],
        functionSlots: [["root", []]],
        externalSymbols: [],
      },
    ],
    objectGroups: [["root", { groupId: 0, root: "root", handle: 1n }]],
    aliases: [],
    globalOrder: ["root"],
    owners: [],
    ownerNames: [],
    nextOwner: 1,
    symbols: [],
  };
}

function initializationHookMainModule() {
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    // One funcref table and the mutable stack pointer required by ProcessDylink.
    ...section(4, [1, 0x70, 1, ...u32(3), ...u32(4096)]),
    ...section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]),
    ...section(7, [
      2,
      ...text("__indirect_function_table"),
      1,
      0,
      ...text("__stack_pointer"),
      3,
      0,
    ]),
  ]);
}

function initializationHookDynamicModule(options: { mutableGlobal?: boolean } = {}) {
  const dylink = [
    ...section(1, [...u32(0), ...u32(0), ...u32(1), ...u32(0)]),
    ...section(2, [...u32(0)]),
    ...section(3, [
      ...u32(2),
      ...text("__wasm_call_ctors"),
      ...u32(0),
      ...text("published_symbol"),
      ...u32(0),
    ]),
    ...section(4, [...u32(0)]),
  ];
  const imports = [
    4,
    ...text("env"),
    ...text("memory"),
    2,
    3, // shared memory with a maximum
    ...u32(1),
    ...u32(4),
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(3),
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
  ];
  // The constructor writes a marker into shared linear memory. Its execution
  // is observable without adding a host callback to the dynamic module.
  const body = [0, 0x41, 32, 0x41, 32, 0x28, 2, 0, 0x41, 1, 0x6a, 0x36, 2, 0, 0x0b];
  const emptyBody = [0, 0x0b];
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(0, [...text("dylink.0"), ...dylink]),
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, imports),
    ...section(3, [2, 0, 0]),
    ...(options.mutableGlobal ? section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]) : []),
    ...section(7, [2, ...text("__wasm_call_ctors"), 0, 0, ...text("published_symbol"), 0, 1]),
    ...section(10, [2, ...u32(body.length), ...body, ...u32(emptyBody.length), ...emptyBody]),
  ]);
}

function callablePublicationDynamicModule() {
  const dylink = [
    ...section(1, [...u32(0), ...u32(0), ...u32(1), ...u32(0)]),
    ...section(2, [...u32(0)]),
    ...section(3, [...u32(1), ...text("after_value"), ...u32(0)]),
    ...section(4, [...u32(0)]),
  ];
  const imports = [
    4,
    ...text("env"),
    ...text("memory"),
    2,
    3,
    ...u32(1),
    ...u32(4),
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(3),
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
    ...section(0, [...text("dylink.0"), ...dylink]),
    ...section(1, [1, 0x60, 0, 1, 0x7f]),
    ...section(2, imports),
    ...section(3, [1, 0]),
    ...section(7, [1, ...text("after_value"), 0, 0]),
    ...section(10, [1, 4, 0, 0x41, 42, 0x0b]),
  ]);
}

function emptyPublicationBaseModule() {
  const imports = [
    4,
    ...text("env"),
    ...text("memory"),
    2,
    3,
    ...u32(1),
    ...u32(4),
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(3),
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
    ...section(0, [
      ...text("dylink.0"),
      ...section(1, [...u32(0), ...u32(0), ...u32(0), ...u32(0)]),
      ...section(2, [0]),
      ...section(3, [0]),
      ...section(4, [0]),
    ]),
    ...section(2, imports),
    ...section(7, [0]),
  ]);
}

function makeInitializationHookProcess(
  dynamicBytes: Uint8Array<ArrayBuffer>,
  options: {
    memory?: WebAssembly.Memory;
    table?: WebAssembly.Table;
    beforeInitializeActive?: () => boolean;
    beforeInitialize?: (
      snapshot: DylinkWorkerSnapshot,
      ownerRollback?: DylinkWorkerOwnerRollback,
    ) => void;
    postThread?: () => boolean;
    queryBlocked?: () => boolean;
    blocked?: () => boolean;
    workerPublicationState?: {
      processIdentity: string;
      generation: number;
      snapshot: DylinkWorkerSnapshot;
    };
  } = {},
) {
  const memory = options.memory ?? new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const mainInstance = new WebAssembly.Instance(
    new WebAssembly.Module(initializationHookMainModule()),
  );
  const mainExports = mainInstance.exports;
  const table = options.table ?? (mainExports.__indirect_function_table as WebAssembly.Table);
  const descriptorAddress = 512;
  const fileAddress = 2048;
  const originAddress = 1024;
  const descriptor = new DataView(memory.buffer);
  let allocation = 16384;
  let nextPin = 1;
  const activeAllocations = new Set<number>();
  const activePins = new Set<number>();
  let nextDynamicBytes = dynamicBytes;
  let currentPath = "";
  const callbacks = {
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate(size: number, alignment = 1) {
      const aligned = Math.ceil(allocation / alignment) * alignment;
      if (aligned + size > memory.buffer.byteLength) return 0;
      allocation = aligned + size;
      activeAllocations.add(aligned);
      return aligned;
    },
    __wasm_dlopen_deallocate(pointer: number) {
      activeAllocations.delete(pointer);
    },
    __wasm_dlopen_read(pathPointer: number) {
      const bytes = new Uint8Array(memory.buffer);
      let end = pathPointer;
      while (end < bytes.length && bytes[end] !== 0) end++;
      currentPath = new TextDecoder().decode(bytes.subarray(pathPointer, end));
      let fileIdentity = 0xcbf29ce484222325n;
      for (const character of currentPath)
        fileIdentity =
          ((fileIdentity ^ BigInt(character.codePointAt(0)!)) * 0x100000001b3n) &
          0xffffffffffffffffn;
      if (!fileIdentity) fileIdentity = 1n;
      new Uint8Array(memory.buffer, fileAddress, nextDynamicBytes.length).set(nextDynamicBytes);
      descriptor.setBigUint64(descriptorAddress, BigInt(fileAddress), true);
      descriptor.setBigUint64(descriptorAddress + 8, BigInt(nextDynamicBytes.length), true);
      descriptor.setBigUint64(descriptorAddress + 16, 1n, true);
      descriptor.setBigUint64(descriptorAddress + 24, fileIdentity, true);
      descriptor.setBigUint64(descriptorAddress + 32, 0n, true);
      return descriptorAddress;
    },
    __wasm_dlopen_read_release: () => {},
    __wasm_dlopen_origin() {
      const encoded = new TextEncoder().encode(`${currentPath}\0`);
      new Uint8Array(memory.buffer, originAddress, encoded.length).set(encoded);
      return originAddress;
    },
    __wasm_dlopen_fd: () => 3,
    __wasm_dlopen_library_path: () => 0,
    __wasm_dlopen_main_path: () => 0,
  };
  const exports = Object.assign({}, mainExports, callbacks);
  exports.__indirect_function_table = table;
  const process = new ProcessDylink({
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address: "i32",
    maximumPages: 4,
    tableType: { address: "i32", minimum: BigInt(table.length), maximum: 4096n },
    signatures: new Map(),
    privateExports: new Set(Object.keys(callbacks)),
    blocked: options.blocked ?? (() => false),
    ...(options.queryBlocked ? { queryBlocked: options.queryBlocked } : {}),
    ...(options.postThread ? { postThread: options.postThread } : {}),
    ...(options.beforeInitializeActive
      ? { beforeInitializeActive: options.beforeInitializeActive }
      : {}),
    ...(options.beforeInitialize ? { beforeInitialize: options.beforeInitialize } : {}),
    ...(options.workerPublicationState
      ? {
          replay: options.workerPublicationState.snapshot,
          workerPublicationState: options.workerPublicationState,
        }
      : {}),
    isControlFlow: () => false,
    fatal(error: unknown): never {
      throw error;
    },
    pinFile: () => {
      const pin = nextPin++;
      activePins.add(pin);
      return pin;
    },
    unpinFile: (pin) => {
      activePins.delete(pin);
      return 0;
    },
  });
  const pathAddress = 256;
  const path = new TextEncoder().encode("/plugins/ctor.so\0");
  new Uint8Array(memory.buffer, pathAddress, path.length).set(path);
  return {
    process,
    memory,
    pathAddress,
    table,
    get activeAllocationCount() {
      return activeAllocations.size;
    },
    get activePinCount() {
      return activePins.size;
    },
    setDynamicBytes(bytes: Uint8Array<ArrayBuffer>) {
      nextDynamicBytes = bytes;
    },
  };
}

test("new dynamic group publication hook runs before constructors and leaves default initialization intact", () => {
  const dynamicBytes = initializationHookDynamicModule();
  new WebAssembly.Module(dynamicBytes);

  let hookedMemory: WebAssembly.Memory | undefined;
  const hooked = makeInitializationHookProcess(dynamicBytes, {
    beforeInitialize(snapshot) {
      validate_dylink_worker_snapshot(snapshot);
      assert.equal(new DataView(hookedMemory!.buffer).getUint32(32, true), 0);
      assert.equal(snapshot.groups.length, 1);
      assert.equal(snapshot.files[0]?.path, "/plugins/ctor.so");
      assert.ok(snapshot.symbols.some(([name]) => name === "published_symbol"));
      assert.ok(snapshot.main.tableSlots.some((slot) => slot !== null));
      assert.notEqual(snapshot.files[0]?.bytes, dynamicBytes);
      snapshot.files[0]!.bytes[0] = 0;
    },
  });
  hookedMemory = hooked.memory;
  assert.notEqual(hooked.process.open(hooked.pathAddress, 2 | 256), 0);
  assert.equal(new DataView(hooked.memory.buffer).getUint32(32, true), 1);
  assert.deepEqual(
    hooked.process.exportWorkerSnapshot().files[0]?.bytes,
    dynamicBytes,
    "the hook receives detached bytes rather than mutable loader-owned file bytes",
  );

  const ordinary = makeInitializationHookProcess(dynamicBytes);
  assert.notEqual(ordinary.process.open(ordinary.pathAddress, 2), 0);
  assert.equal(new DataView(ordinary.memory.buffer).getUint32(32, true), 1);

  const failed = makeInitializationHookProcess(dynamicBytes, {
    beforeInitialize() {
      throw new Error("publication failed");
    },
  });
  assert.throws(() => failed.process.open(failed.pathAddress, 2), DylinkInitializationError);
  assert.equal(new DataView(failed.memory.buffer).getUint32(32, true), 0);

  let postThreadHookCalls = 0;
  const postThread = makeInitializationHookProcess(dynamicBytes, {
    postThread: () => true,
    beforeInitialize() {
      postThreadHookCalls++;
    },
  });
  assert.equal(postThread.process.open(postThread.pathAddress, 2), 0);
  assert.equal(
    postThreadHookCalls,
    0,
    "a new post-thread group remains rejected before publication",
  );
  assert.equal(new DataView(postThread.memory.buffer).getUint32(32, true), 0);

  let vforkHookCalls = 0;
  const vfork = makeInitializationHookProcess(dynamicBytes, {
    queryBlocked: () => true,
    beforeInitialize() {
      vforkHookCalls++;
    },
  });
  assert.equal(vfork.process.open(vfork.pathAddress, 2), 0);
  assert.equal(vforkHookCalls, 0, "the vfork gate still rejects before publication");
  assert.equal(new DataView(vfork.memory.buffer).getUint32(32, true), 0);
});

test("inactive Worker publication skips snapshots for ordinary non-replayable modules", () => {
  let activeChecks = 0;
  let hookCalls = 0;
  const fixture = makeInitializationHookProcess(
    initializationHookDynamicModule({ mutableGlobal: true }),
    {
      beforeInitializeActive: () => {
        activeChecks++;
        return false;
      },
      beforeInitialize() {
        hookCalls++;
        throw new Error("inactive Worker publication hook must not run");
      },
    },
  );

  assert.doesNotThrow(
    () => new WebAssembly.Module(initializationHookDynamicModule({ mutableGlobal: true })),
  );
  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  assert.equal(activeChecks, 1);
  assert.equal(hookCalls, 0);
  assert.equal(
    new DataView(fixture.memory.buffer).getUint32(32, true),
    1,
    "the normal loader runs the constructor for a module rejected by Worker replay",
  );
});

test("loader adopts one worker publication baseline without rerunning constructors", () => {
  const dynamicBytes = initializationHookDynamicModule();
  const process = makeInitializationHookProcess(dynamicBytes);
  assert.notEqual(process.process.open(process.pathAddress, 2), 0);
  assert.equal(new DataView(process.memory.buffer).getUint32(32, true), 1);

  const baseline = process.process.initializeWorkerPublication("process-identity");
  assert.equal(baseline.processIdentity, "process-identity");
  assert.equal(baseline.generation, 0);
  validate_dylink_worker_snapshot(baseline.snapshot);
  assert.equal(new DataView(process.memory.buffer).getUint32(32, true), 1);

  const readOnlyState = process.process.getWorkerPublicationState();
  assert.ok(readOnlyState);
  assert.deepEqual(readOnlyState, baseline);
  assert.notEqual(readOnlyState.snapshot, baseline.snapshot);
  readOnlyState.snapshot.files[0]!.bytes[0] = 0;
  assert.deepEqual(process.process.getWorkerPublicationState(), baseline);

  const repeated = process.process.initializeWorkerPublication("process-identity");
  assert.deepEqual(repeated, baseline);
  assert.throws(
    () => process.process.initializeWorkerPublication("another-process"),
    DylinkWorkerSnapshotError,
  );

  assert.equal(
    BigInt(process.process.open(process.pathAddress, 2 | 256)),
    baseline.snapshot.groups[0]!.handle,
  );
  assert.throws(
    () => process.process.initializeWorkerPublication("process-identity"),
    DylinkWorkerSnapshotError,
  );
  assert.throws(() => process.process.getWorkerPublicationState(), DylinkWorkerSnapshotError);
  assert.equal(new DataView(process.memory.buffer).getUint32(32, true), 1);

  process.process.discardWorkerPublicationBeforeThreads();
  assert.equal(process.process.getWorkerPublicationState(), null);
  const retry = process.process.initializeWorkerPublication("retry-process-identity");
  assert.equal(retry.processIdentity, "retry-process-identity");
  assert.equal(retry.generation, 0);
  validate_dylink_worker_snapshot(retry.snapshot);
  assert.equal(new DataView(process.memory.buffer).getUint32(32, true), 1);

  let postThread = false;
  const late = makeInitializationHookProcess(dynamicBytes, { postThread: () => postThread });
  assert.notEqual(late.process.open(late.pathAddress, 2), 0);
  postThread = true;
  assert.throws(
    () => late.process.initializeWorkerPublication("too-late"),
    DylinkWorkerSnapshotError,
  );
  assert.throws(
    () => late.process.discardWorkerPublicationBeforeThreads(),
    DylinkWorkerSnapshotError,
  );

  const generationOneProcess = makeInitializationHookProcess(dynamicBytes, {
    workerPublicationState: { ...baseline, generation: 1 },
  });
  assert.throws(
    () => generationOneProcess.process.discardWorkerPublicationBeforeThreads(),
    DylinkWorkerSnapshotError,
  );

  const blocked = makeInitializationHookProcess(dynamicBytes, { blocked: () => true });
  assert.throws(
    () => blocked.process.initializeWorkerPublication("vfork-blocked"),
    DylinkWorkerSnapshotError,
  );
  assert.equal(blocked.process.getWorkerPublicationState(), null);
});

test("owner advances its Worker baseline only for the current pre-constructor publication", () => {
  const dynamicBytes = initializationHookDynamicModule();
  let fixture: ReturnType<typeof makeInitializationHookProcess>;
  let publishedSnapshot: DylinkWorkerSnapshot | undefined;
  let advanced: ReturnType<ProcessDylink["advanceWorkerPublicationBeforeInitialize"]> | undefined;
  fixture = makeInitializationHookProcess(dynamicBytes, {
    beforeInitialize(snapshot) {
      publishedSnapshot = snapshot;
      assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 0);
      assert.throws(
        () =>
          fixture.process.advanceWorkerPublicationBeforeInitialize("wrong-identity", 0, snapshot),
        DylinkWorkerSnapshotError,
      );
      assert.throws(
        () =>
          fixture.process.advanceWorkerPublicationBeforeInitialize("owner-process", 1, snapshot),
        DylinkWorkerSnapshotError,
      );
      assert.throws(
        () =>
          fixture.process.advanceWorkerPublicationBeforeInitialize(
            "owner-process",
            0,
            prepare_dylink_worker_snapshot(snapshot),
          ),
        DylinkWorkerSnapshotError,
      );

      advanced = fixture.process.advanceWorkerPublicationBeforeInitialize(
        "owner-process",
        0,
        snapshot,
      );
      assert.equal(advanced.generation, 1);
      assert.throws(
        () =>
          fixture.process.advanceWorkerPublicationBeforeInitialize("owner-process", 0, snapshot),
        DylinkWorkerSnapshotError,
      );
    },
  });
  const baseline = fixture.process.initializeWorkerPublication("owner-process");
  assert.equal(baseline.generation, 0);
  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  assert.ok(publishedSnapshot);
  assert.ok(advanced);
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 1);
  assert.deepEqual(fixture.process.getWorkerPublicationState(), advanced);
  assert.equal(advanced.snapshot.groups.length, 1);
  assert.throws(
    () =>
      fixture.process.advanceWorkerPublicationBeforeInitialize(
        "owner-process",
        0,
        publishedSnapshot!,
      ),
    DylinkWorkerSnapshotError,
    "advancement outside the matching initialization hook is rejected",
  );
});

test("owner refuses to advance a publication snapshot after its graph changes", () => {
  const dynamicBytes = initializationHookDynamicModule();
  let fixture: ReturnType<typeof makeInitializationHookProcess>;
  fixture = makeInitializationHookProcess(dynamicBytes, {
    beforeInitialize(snapshot) {
      const nameAddress = 512;
      const encodedName = new TextEncoder().encode("published_symbol\0");
      new Uint8Array(fixture.memory.buffer, nameAddress, encodedName.length).set(encodedName);
      const group = snapshot.groups[0]!;
      const functionAddress = fixture.process.symbol(group.handle, nameAddress);
      assert.notEqual(BigInt(functionAddress), 0n);
      assert.equal(fixture.process.address(functionAddress, 1024), 1);
      assert.throws(
        () =>
          fixture.process.advanceWorkerPublicationBeforeInitialize("owner-process", 0, snapshot),
        DylinkWorkerSnapshotError,
      );
    },
  });
  fixture.process.initializeWorkerPublication("owner-process");
  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 1);
  assert.throws(() => fixture.process.getWorkerPublicationState(), DylinkWorkerSnapshotError);
});

test("owner refuses to advance when its baseline was already stale at publication start", () => {
  const dynamicBytes = initializationHookDynamicModule();
  let fixture: ReturnType<typeof makeInitializationHookProcess>;
  let hookCount = 0;
  fixture = makeInitializationHookProcess(dynamicBytes, {
    beforeInitialize(snapshot) {
      hookCount++;
      if (hookCount === 1) return;
      assert.throws(
        () =>
          fixture.process.advanceWorkerPublicationBeforeInitialize("owner-process", 0, snapshot),
        DylinkWorkerSnapshotError,
      );
    },
  });

  const originalHandle = BigInt(fixture.process.open(fixture.pathAddress, 2));
  const baseline = fixture.process.initializeWorkerPublication("owner-process");
  assert.equal(baseline.generation, 0);

  const nameAddress = 512;
  const encodedName = new TextEncoder().encode("published_symbol\0");
  new Uint8Array(fixture.memory.buffer, nameAddress, encodedName.length).set(encodedName);
  const functionAddress = fixture.process.symbol(originalHandle, nameAddress);
  assert.notEqual(BigInt(functionAddress), 0n);
  assert.equal(fixture.process.address(functionAddress, 1024), 1);

  const nextPath = new TextEncoder().encode("/plugins/next.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, nextPath.length).set(nextPath);
  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  assert.equal(hookCount, 2);
  assert.throws(() => fixture.process.getWorkerPublicationState(), DylinkWorkerSnapshotError);
});

test("scoped Worker producer preflights and publishes one local group after threads exist", () => {
  const dynamicBytes = initializationHookDynamicModule();
  let fixture: ReturnType<typeof makeInitializationHookProcess>;
  let postThread = false;
  let vforkBlocked = false;
  let hookCalls = 0;
  let hasBaseline = false;
  let baselineGeneration = 0;
  fixture = makeInitializationHookProcess(dynamicBytes, {
    postThread: () => postThread,
    queryBlocked: () => vforkBlocked,
    beforeInitialize(snapshot, ownerRollback) {
      hookCalls++;
      if (!hasBaseline) return;
      const advanced = fixture.process.advanceWorkerPublicationBeforeInitialize(
        "worker-process",
        baselineGeneration,
        snapshot,
      );
      baselineGeneration = advanced.generation;
      ownerRollback?.commit();
    },
  });
  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  const baseline = fixture.process.initializeWorkerPublication("worker-process");
  hasBaseline = true;
  baselineGeneration = baseline.generation;
  assert.equal(baseline.generation, 0);
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 1);

  postThread = true;
  const nextPath = new TextEncoder().encode("/plugins/next.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, nextPath.length).set(nextPath);
  assert.equal(
    fixture.process.openWithWorkerPublication(fixture.pathAddress, 2, "wrong-process", 0),
    0,
  );
  assert.equal(
    fixture.process.openWithWorkerPublication(fixture.pathAddress, 2, "worker-process", 1),
    0,
  );
  vforkBlocked = true;
  assert.equal(
    fixture.process.openWithWorkerPublication(fixture.pathAddress, 2, "worker-process", 0),
    0,
  );
  vforkBlocked = false;
  const handle = fixture.process.openWithWorkerPublication(
    fixture.pathAddress,
    2,
    "worker-process",
    0,
  );
  assert.notEqual(handle, 0);
  assert.equal(hookCalls, 2);
  const published = fixture.process.getWorkerPublicationState();
  assert.ok(published);
  assert.equal(published.processIdentity, "worker-process");
  assert.equal(published.generation, 1);
  assert.equal(published.snapshot.groups.length, 2);
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 2);

  const reopened = fixture.process.openWithWorkerPublication(
    fixture.pathAddress,
    2,
    "worker-process",
    1,
  );
  assert.equal(reopened, handle, "a fully initialized group reopens to its existing handle");
  assert.equal(hookCalls, 2, "reopening does not enter the publication hook");
  assert.equal(
    new DataView(fixture.memory.buffer).getUint32(32, true),
    2,
    "reopening does not rerun constructors",
  );
  assert.deepEqual(
    fixture.process.getWorkerPublicationState(),
    published,
    "reopening does not advance the graph",
  );

  const laterPath = new TextEncoder().encode("/plugins/later.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, laterPath.length).set(laterPath);
  const nextHandle = fixture.process.openWithWorkerPublication(
    fixture.pathAddress,
    2,
    "worker-process",
    1,
  );
  assert.notEqual(nextHandle, 0, "the unchanged baseline remains available for a new publication");
  assert.equal(hookCalls, 3);
  assert.equal(fixture.process.getWorkerPublicationState()?.generation, 2);
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 3);

  const rejectedGlobal = fixture.process.openWithWorkerPublication(
    fixture.pathAddress,
    2 | 256,
    "worker-process",
    2,
  );
  assert.equal(rejectedGlobal, 0);
  assert.equal(fixture.process.getWorkerPublicationState()?.generation, 2);

  const ordinaryPath = new TextEncoder().encode("/plugins/ordinary.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, ordinaryPath.length).set(ordinaryPath);
  assert.equal(fixture.process.open(fixture.pathAddress, 2), 0);
  assert.equal(hookCalls, 3, "ordinary open remains blocked after thread creation");
});

test("scoped Worker abort restores the owner before returning a dlopen failure", () => {
  let fixture: ReturnType<typeof makeInitializationHookProcess>;
  let postThread = false;
  let writer: DylinkWorkerWriter | undefined;
  fixture = makeInitializationHookProcess(initializationHookDynamicModule(), {
    postThread: () => postThread,
    queryBlocked: () => false,
    beforeInitialize(snapshot, ownerRollback) {
      if (!postThread) return;
      assert.ok(ownerRollback, "the scoped publication hook receives an owner rollback token");
      assert.ok(writer, "the Worker writer is installed before post-thread opens");
      writer.beforeInitialize(snapshot, ownerRollback);
    },
  });

  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  const baseline = fixture.process.initializeWorkerPublication("rollback-process");
  const allocationCount = fixture.activeAllocationCount;
  const pinCount = fixture.activePinCount;
  postThread = true;

  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = channel.register();
  const receiverParticipant = channel.register();
  assert.equal(writerParticipant.ok, true);
  assert.equal(receiverParticipant.ok, true);
  if (!writerParticipant.ok || !receiverParticipant.ok)
    assert.fail("could not register the Worker cohort");
  const receiverProcess = makeInitializationHookProcess(initializationHookDynamicModule(), {
    memory: fixture.memory,
    postThread: () => true,
    workerPublicationState: baseline,
  }).process;
  const receiver = new DylinkWorkerReceiver(
    channel,
    receiverParticipant.value,
    receiverProcess,
    (error) => {
      throw error;
    },
  );
  let failNextNotification = true;
  let writerFatalCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant.value,
    fixture.process,
    (error) => {
      writerFatalCalls++;
      throw error;
    },
    () => {
      receiver.step();
    },
    30_000,
    () => {
      if (failNextNotification) {
        failNextNotification = false;
        throw new Error("Prepare notification failed");
      }
      receiver.step();
    },
  );

  const rejectedPath = new TextEncoder().encode("/plugins/rejected.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, rejectedPath.length).set(rejectedPath);
  assert.equal(writer.open(fixture.pathAddress, 2), 0);
  assert.equal(writerFatalCalls, 0);
  assert.deepEqual(fixture.process.getWorkerPublicationState(), baseline);
  assert.equal(
    new DataView(fixture.memory.buffer).getUint32(32, true),
    1,
    "the rejected constructor did not run",
  );
  assert.equal(
    fixture.activeAllocationCount,
    allocationCount,
    "new link-map/data allocations were released",
  );
  assert.equal(fixture.activePinCount, pinCount, "the rejected module's file pin was released");
  const errorAddress = 8192;
  assert.equal(fixture.process.error(errorAddress, 128), 0);
  const errorBytes = new Uint8Array(fixture.memory.buffer, errorAddress, 128);
  const errorEnd = errorBytes.indexOf(0);
  assert.equal(
    new TextDecoder().decode(errorBytes.subarray(0, errorEnd)),
    "Worker publication was rolled back: Prepare notification failed",
  );

  const retryPath = new TextEncoder().encode("/plugins/retry.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, retryPath.length).set(retryPath);
  assert.notEqual(
    writer.open(fixture.pathAddress, 2),
    0,
    "a later publication can reuse the unchanged baseline after Abort returns to Idle",
  );
  assert.equal(fixture.process.getWorkerPublicationState()?.generation, 1);
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 2);
});

test("scoped Worker producer rejects a non-replayable module before its constructor", () => {
  const dynamicBytes = initializationHookDynamicModule();
  let fixture: ReturnType<typeof makeInitializationHookProcess>;
  let postThread = false;
  let hookCalls = 0;
  fixture = makeInitializationHookProcess(dynamicBytes, {
    postThread: () => postThread,
    queryBlocked: () => false,
    beforeInitialize(snapshot) {
      hookCalls++;
      const state = fixture.process.getWorkerPublicationState();
      if (state)
        fixture.process.advanceWorkerPublicationBeforeInitialize(
          state.processIdentity,
          state.generation,
          snapshot,
        );
    },
  });
  assert.notEqual(fixture.process.open(fixture.pathAddress, 2), 0);
  fixture.process.initializeWorkerPublication("worker-process");
  const allocationCount = fixture.activeAllocationCount;
  const pinCount = fixture.activePinCount;
  assert.equal(new DataView(fixture.memory.buffer).getUint32(32, true), 1);

  postThread = true;
  fixture.setDynamicBytes(initializationHookDynamicModule({ mutableGlobal: true }));
  const path = new TextEncoder().encode("/plugins/unsupported.so\0");
  new Uint8Array(fixture.memory.buffer, fixture.pathAddress, path.length).set(path);
  assert.equal(
    fixture.process.openWithWorkerPublication(fixture.pathAddress, 2, "worker-process", 0),
    0,
  );
  assert.equal(hookCalls, 1, "replay preflight rejects before the publication hook");
  assert.equal(
    new DataView(fixture.memory.buffer).getUint32(32, true),
    1,
    "rejected module constructors did not run",
  );
  assert.equal(fixture.process.getWorkerPublicationState()?.generation, 0);
  assert.equal(
    fixture.activeAllocationCount,
    allocationCount,
    "preflight failure releases temporary allocations",
  );
  assert.equal(fixture.activePinCount, pinCount, "preflight failure releases the new file pin");
});

test("scoped Worker reopen cancels its unused reservation for the next producer", () => {
  let postThread = false;
  const fixture = makeInitializationHookProcess(initializationHookDynamicModule(), {
    postThread: () => postThread,
    queryBlocked: () => false,
    beforeInitialize() {},
  });
  const originalHandle = fixture.process.open(fixture.pathAddress, 2);
  assert.notEqual(originalHandle, 0);
  const baseline = fixture.process.initializeWorkerPublication("reopen-reservation-test");
  postThread = true;

  const channel = new DylinkWorkerChannel(1024, 1);
  const participant = channel.register();
  if (!participant.ok) assert.fail(`participant registration failed (${participant.errno})`);
  const writer = new DylinkWorkerWriter(
    channel,
    participant.value,
    fixture.process,
    (error) => {
      throw error;
    },
    () => assert.fail("an idle reservation should not need to wait"),
  );

  const reopened = writer.open(fixture.pathAddress, 2);
  assert.equal(reopened, originalHandle);
  assert.equal(fixture.process.getWorkerPublicationState()?.generation, baseline.generation);
  const observation = channel.observe();
  if (!observation.ok) assert.fail(`channel observation failed (${observation.errno})`);
  assert.equal(observation.value.state, "idle");

  const reusable = channel.reserve(participant.value);
  if (!reusable.ok) assert.fail(`reopen left its reservation behind (${reusable.errno})`);
  assert.equal(channel.cancelReservation(reusable.value).ok, true);
});

test("published new exports keep their canonical slots callable through receiver dlsym", () => {
  const baseBytes = emptyPublicationBaseModule();
  let postThread = false;
  let baselineReady = false;
  let baselineGeneration = 0;
  let parent!: ReturnType<typeof makeInitializationHookProcess>;
  parent = makeInitializationHookProcess(baseBytes, {
    postThread: () => postThread,
    queryBlocked: () => false,
    beforeInitialize(snapshot, ownerRollback) {
      if (!baselineReady) return;
      const advanced = parent.process.advanceWorkerPublicationBeforeInitialize(
        "callable-publication",
        baselineGeneration,
        snapshot,
      );
      baselineGeneration = advanced.generation;
      ownerRollback?.commit();
    },
  });
  assert.notEqual(parent.process.open(parent.pathAddress, 2), 0);
  const baseline = parent.process.initializeWorkerPublication("callable-publication");
  baselineReady = true;

  const child = makeInitializationHookProcess(baseBytes, {
    memory: parent.memory,
    table: parent.table,
    workerPublicationState: baseline,
  });

  postThread = true;
  parent.setDynamicBytes(callablePublicationDynamicModule());
  const nextPath = new TextEncoder().encode("/plugins/after.so\0");
  new Uint8Array(parent.memory.buffer, parent.pathAddress, nextPath.length).set(nextPath);
  assert.notEqual(
    parent.process.openWithWorkerPublication(
      parent.pathAddress,
      2,
      "callable-publication",
      baseline.generation,
    ),
    0,
  );

  const published = parent.process.getWorkerPublicationState();
  assert.ok(published);
  const newGroup = published.snapshot.groups.at(-1);
  assert.ok(newGroup);
  assert.ok(
    newGroup.functionSlots.some(([, slots]) => slots.some(([name]) => name === "after_value")),
    "the new export must be assigned a canonical slot before the publication snapshot is built",
  );

  const publication = create_dylink_worker_publication_delta(
    baseline.snapshot,
    published.snapshot,
    published.processIdentity,
    baseline.generation,
  );
  const candidate = child.process.prepareWorkerExtension(publication);
  child.process.commitWorkerExtension(candidate);

  const nameAddress = 768;
  const encodedName = new TextEncoder().encode("after_value\0");
  new Uint8Array(child.memory.buffer, nameAddress, encodedName.length).set(encodedName);
  const address = child.process.symbol(newGroup.handle, nameAddress);
  assert.notEqual(address, 0, "receiver dlsym must resolve the published function");
  const callable = child.table.get(Number(address));
  assert.equal(typeof callable, "function");
  assert.equal((callable as () => number)(), 42);
});

function emptyWorkerSnapshot() {
  return prepare_dylink_worker_snapshot({
    version: 1,
    address: "i32",
    tableAddress: "i32",
    main: {
      handle: 0n,
      lastMap: 0n,
      cursor: 0n,
      tableLength: 0,
      functionSlots: [],
      tableSlots: [],
      addressNames: [],
    },
    files: [],
    groups: [],
    objectGroups: [],
    aliases: [],
    globalOrder: [],
    owners: [],
    ownerNames: [],
    nextOwner: 1,
    symbols: [],
  });
}

test("Worker graph publications carry only the new group and copy foreign module bytes", () => {
  const current = emptyWorkerSnapshot();
  const bytes = activeEmptyElementModule();
  const publication = prepare_dylink_worker_publication(current, "process-1", 0, {
    main: {
      handle: 0n,
      lastMap: 0n,
      cursor: 3n,
      tableLength: 3,
      functionSlots: [],
      tableSlots: [],
      addressNames: [],
    },
    files: [{ key: "root", path: "/root.so", bytes, pin: 1, dependencies: [] }],
    groups: [
      {
        id: 0,
        root: "root",
        handle: 1n,
        order: ["root"],
        lazyFunctions: [],
        placements: [["root", { base: 128n, tableBase: 3n }]],
        functionSlots: [["root", []]],
        externalSymbols: [],
      },
    ],
    groupFunctionSlots: [],
    objectGroups: [["root", { groupId: 0, root: "root", handle: 1n }]],
    aliases: [],
    globalOrder: ["root"],
    owners: [],
    ownerNames: [],
    nextOwner: 1,
    symbols: [],
  });

  assert.equal(publication.baseGeneration, 0);
  assert.equal(publication.generation, 1);
  assert.equal(publication.files.length, 1, "the message contains only newly pinned files");
  assert.equal(publication.groups.length, 1, "the message contains only newly committed groups");
  assert.notEqual(
    publication.files[0]?.bytes.buffer,
    bytes.buffer,
    "publication owns its byte copy",
  );
  const detachedBytes = publication.files[0]!.bytes.slice();
  bytes.fill(0);
  assert.deepEqual(
    publication.files[0]?.bytes,
    detachedBytes,
    "caller mutation cannot alter the prepared publication",
  );
  assert.throws(
    () => (publication.groups as unknown[]).push({}),
    TypeError,
    "publication records are frozen",
  );

  const received = structuredClone(publication);
  const applied = apply_dylink_worker_publication(current, "process-1", 0, received);
  received.files[0]!.bytes.fill(0);
  assert.equal(applied.generation, 1);
  assert.equal(applied.snapshot.files.length, 1);
  assert.deepEqual(
    applied.snapshot.files[0]?.bytes,
    detachedBytes,
    "the detached bytes retain their pre-mutation content",
  );
  assert.equal(
    current.files.length,
    0,
    "applying a delta leaves the previous generation untouched",
  );
  assert.throws(
    () => apply_dylink_worker_publication(current, "other-process", 0, publication),
    /different process/,
  );
  assert.throws(
    () => apply_dylink_worker_publication(current, "process-1", 1, publication),
    /generation/,
  );
});

test("Worker snapshot admission parses an empty active table-zero element vector", () => {
  const module = activeEmptyElementModule();
  assert.doesNotThrow(() => new WebAssembly.Module(module));

  const prepared = prepare_dylink_worker_snapshot({
    version: 1,
    address: "i32",
    tableAddress: "i32",
    main: {
      handle: 0n,
      lastMap: 0n,
      cursor: 3n,
      tableLength: 3,
      functionSlots: [],
      tableSlots: [null, null, null],
      addressNames: [],
    },
    files: [{ key: "root", path: "/root.so", bytes: module, pin: 1, dependencies: [] }],
    groups: [
      {
        id: 0,
        root: "root",
        handle: 1n,
        order: ["root"],
        lazyFunctions: [],
        placements: [["root", { base: 128n, tableBase: 3n }]],
        functionSlots: [],
        externalSymbols: [],
      },
    ],
    objectGroups: [["root", { groupId: 0, root: "root", handle: 1n }]],
    aliases: [],
    globalOrder: ["root"],
    owners: [],
    ownerNames: [],
    nextOwner: 1,
    symbols: [],
  });

  assert.deepEqual(prepared.files[0]?.bytes, module);
  assert.notEqual(
    prepared.files[0]?.bytes.buffer,
    module.buffer,
    "snapshot preparation copies source bytes",
  );
});

test("Worker snapshot admission accepts only a zero-sized empty TLS compiler scaffold", () => {
  const module = emptyTlsScaffoldModule();
  const compiled = new WebAssembly.Module(module);
  assert.deepEqual(inspect_dylink_worker_empty_tls_scaffold(module, "i64", compiled), {
    importedGlobals: 2,
    baseGlobalIndex: 2,
  });
  assert.deepEqual(
    [...(inspect_dylink_worker_memory_initializer(module, "i64", compiled) ?? [])],
    [0],
  );

  const replayBytes = prepare_dylink_worker_module(module, "i64");
  const replay = new WebAssembly.Module(replayBytes);
  assert.equal(
    WebAssembly.Module.exports(replay).some((entry) => entry.name === "__wasm_init_memory"),
    true,
  );
  let foundStart = false;
  let dataSection: number[] | undefined;
  for (let offset = 8; offset < replayBytes.length;) {
    const id = replayBytes[offset++]!;
    let length = 0;
    let shift = 0;
    while (true) {
      const byte = replayBytes[offset++]!;
      length |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    if (id === 8) foundStart = true;
    if (id === 11) dataSection = [...replayBytes.subarray(offset, offset + length)];
    offset += length;
  }
  assert.equal(foundStart, false, "replay removes the recognized process start function");
  assert.deepEqual(
    dataSection,
    [1, 1, 0],
    "the proven-dropped segment retains its index as an empty passive segment",
  );

  const prepared = prepare_dylink_worker_snapshot(snapshotWithModule(module));
  assert.deepEqual(prepared.files[0]?.bytes, module);

  const nonzeroSize = emptyTlsScaffoldModule(8n);
  assert.doesNotThrow(() => new WebAssembly.Module(nonzeroSize));
  assert.throws(() => prepare_dylink_worker_snapshot(snapshotWithModule(nonzeroSize)), /zero size/);

  const nonzeroFill = emptyTlsScaffoldModule(0n, false, 1);
  assert.doesNotThrow(() => new WebAssembly.Module(nonzeroFill));
  assert.throws(
    () => prepare_dylink_worker_snapshot(snapshotWithModule(nonzeroFill)),
    /memory.fill must use zero/,
  );
});

test("Worker replay rejects LLD-looking starts that omit a passive data drop", () => {
  const module = emptyTlsScaffoldModule(0n, true);
  assert.doesNotThrow(() => new WebAssembly.Module(module));
  assert.throws(
    () => prepare_dylink_worker_snapshot(snapshotWithModule(module)),
    /unconditionally drop every passive data segment/,
  );
});
