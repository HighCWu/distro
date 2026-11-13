// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { ProcessDylink } from "../src/dylink_process.ts";
import { DylinkWorkerChannel } from "../src/dylink_worker_channel.ts";
import { DylinkWorkerReceiver } from "../src/dylink_worker_receiver.ts";
import { DylinkWorkerWriter } from "../src/dylink_worker_writer.ts";
import type { DylinkWorkerSnapshot } from "../src/dylink_process_worker.ts";

type TestOwnerRollback = { restore(): void; release(): void; commit(): void };

const u32 = (value: number) => {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
};

const text = (value: string) => [
  ...u32(new TextEncoder().encode(value).length),
  ...new TextEncoder().encode(value),
];
const section = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];
const custom = (name: string, payload: number[]) => section(0, [...text(name), ...payload]);
const subsection = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];

/** A real ProcessDylink fixture: shared memory/table imports, dylink metadata,
 * an exported constructor, and one regular function export. */
function dynamicModule(
  mutableGlobal = false,
  constructorProbe = false,
  address: "i32" | "i64" = "i32",
): Uint8Array<ArrayBuffer> {
  const functionIndexOffset = constructorProbe ? 1 : 0;
  const memoryFlags = address === "i64" ? 7 : 3;
  const memoryBaseType = address === "i64" ? 0x7e : 0x7f;
  const memoryAddress = address === "i64" ? [0x42, 32] : [0x41, 32];
  const dylink = [
    ...subsection(1, [...u32(0), ...u32(0), ...u32(0), ...u32(0)]),
    ...subsection(2, [0]),
    ...subsection(3, [
      2,
      ...text("__wasm_call_ctors"),
      ...u32(functionIndexOffset),
      ...text("answer"),
      ...u32(functionIndexOffset + 1),
    ]),
    ...subsection(4, [0]),
  ];
  const imports = [
    constructorProbe ? 5 : 4,
    ...text("env"),
    ...text("memory"),
    2,
    memoryFlags,
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
    memoryBaseType,
    0,
    ...text("env"),
    ...text("__table_base"),
    3,
    memoryBaseType,
    0,
    ...(constructorProbe ? [...text("env"), ...text("__worker_publication_ctor_probe"), 0, 0] : []),
  ];
  const ctor = [
    0,
    ...(constructorProbe ? [0x10, 0] : []),
    ...memoryAddress,
    ...memoryAddress,
    0x28,
    2,
    0,
    0x41,
    1,
    0x6a,
    0x36,
    2,
    0,
    0x0b,
  ];
  const answer = [0, 0x41, 42, 0x0b];
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
    ...section(1, [2, 0x60, 0, 0, 0x60, 0, 1, 0x7f]),
    ...section(2, imports),
    ...section(3, [2, 0, 1]),
    ...(mutableGlobal ? section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]) : []),
    ...section(7, [
      2,
      ...text("__wasm_call_ctors"),
      0,
      functionIndexOffset,
      ...text("answer"),
      0,
      functionIndexOffset + 1,
    ]),
    ...section(10, [2, ...u32(ctor.length), ...ctor, ...u32(answer.length), ...answer]),
  ]);
}

function mainModule(address: "i32" | "i64"): Uint8Array<ArrayBuffer> {
  const memoryFlags = address === "i64" ? 7 : 3;
  const stackGlobal = address === "i64" ? [0x7e, 1, 0x42, 0, 0x0b] : [0x7f, 1, 0x41, 0, 0x0b];
  return new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 0, 0]),
    ...section(2, [
      2,
      ...text("env"),
      ...text("memory"),
      2,
      memoryFlags,
      ...u32(2),
      ...u32(4),
      ...text("env"),
      ...text("__worker_publication_ctor_probe"),
      0,
      0,
    ]),
    ...section(3, [1, 0]),
    ...section(4, [1, 0x70, 1, ...u32(3), ...u32(4096)]),
    ...section(6, [1, ...stackGlobal]),
    ...section(7, [
      3,
      ...text("__indirect_function_table"),
      1,
      0,
      ...text("__stack_pointer"),
      3,
      0,
      ...text("__worker_publication_ctor_probe"),
      0,
      1,
    ]),
    ...section(10, [1, 4, 0, 0x10, 0, 0x0b]),
  ]);
}

function makeProcess(
  memory: WebAssembly.Memory,
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  options: {
    postThread?: () => boolean;
    beforeInitialize?: (snapshot: DylinkWorkerSnapshot, ownerRollback?: TestOwnerRollback) => void;
    replay?: DylinkWorkerSnapshot;
    constructorProbe?: () => void;
    publicationState?: {
      processIdentity: string;
      generation: number;
      snapshot: DylinkWorkerSnapshot;
    };
    address?: "i32" | "i64";
  } = {},
) {
  const address = options.address ?? "i32";
  const wasmWord = (value: number) => (address === "i64" ? BigInt(value) : value);
  const main = new WebAssembly.Instance(new WebAssembly.Module(mainModule(address)), {
    env: {
      memory,
      __worker_publication_ctor_probe: options.constructorProbe ?? (() => {}),
    },
  });
  const descriptorAddress = 512;
  const fileAddress = 2048;
  const originAddress = 1024;
  const descriptor = new DataView(memory.buffer);
  let allocation = 16_384;
  let nextPin = 1;
  let currentPath = "";
  const callbacks = {
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate(size: number | bigint, alignment: number | bigint = 1) {
      const numericSize = Number(size);
      const numericAlignment = Number(alignment);
      const aligned = Math.ceil(allocation / numericAlignment) * numericAlignment;
      allocation = aligned + numericSize;
      return allocation <= memory.buffer.byteLength ? wasmWord(aligned) : wasmWord(0);
    },
    __wasm_dlopen_deallocate: () => {},
    __wasm_dlopen_read(pathPointer: number | bigint) {
      const bytes = new Uint8Array(memory.buffer);
      const pathPointerNumber = Number(pathPointer);
      let end = pathPointerNumber;
      while (end < bytes.length && bytes[end] !== 0) end++;
      currentPath = new TextDecoder().decode(bytes.subarray(pathPointerNumber, end));
      const contents = files.get(currentPath);
      descriptor.setBigUint64(descriptorAddress, BigInt(fileAddress), true);
      descriptor.setBigUint64(descriptorAddress + 8, BigInt(contents?.length ?? 0), true);
      descriptor.setBigUint64(descriptorAddress + 16, 1n, true);
      descriptor.setBigUint64(
        descriptorAddress + 24,
        BigInt([...currentPath].reduce((sum, ch) => sum + ch.codePointAt(0)!, 1)),
        true,
      );
      descriptor.setBigUint64(descriptorAddress + 32, contents ? 0n : 2n, true);
      if (contents) new Uint8Array(memory.buffer, fileAddress, contents.length).set(contents);
      return wasmWord(descriptorAddress);
    },
    __wasm_dlopen_read_release: () => {},
    __wasm_dlopen_origin() {
      const encoded = new TextEncoder().encode(`${currentPath}\0`);
      new Uint8Array(memory.buffer, originAddress, encoded.length).set(encoded);
      return wasmWord(originAddress);
    },
    __wasm_dlopen_fd: () => 3,
    __wasm_dlopen_library_path: () => 0,
    __wasm_dlopen_main_path: () => 0,
  };
  const exports = Object.assign({}, main.exports, callbacks);
  const process = new ProcessDylink({
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address,
    maximumPages: 4,
    tableType: { address: "i32", minimum: 3n, maximum: 4096n },
    signatures: new Map([["__worker_publication_ctor_probe", "[[],[]]"]]),
    privateExports: new Set(Object.keys(callbacks)),
    blocked: () => false,
    queryBlocked: () => false,
    postThread: options.postThread ?? (() => false),
    ...(options.beforeInitialize ? { beforeInitialize: options.beforeInitialize } : {}),
    ...(options.replay ? { replay: options.replay } : {}),
    ...(options.publicationState ? { workerPublicationState: options.publicationState } : {}),
    isControlFlow: () => false,
    fatal(error: unknown): never {
      throw error;
    },
    pinFile: () => nextPin++,
    unpinFile: () => 0,
  });
  const pathAddress = 256;
  return { process, pathAddress };
}

function readDlerror(
  process: ProcessDylink,
  memory: WebAssembly.Memory,
  address: "i32" | "i64",
): string {
  const pointer = address === "i64" ? 8192n : 8192;
  const length = address === "i64" ? 256n : 256;
  assert.equal(process.error(pointer, length), 0);
  const bytes = new Uint8Array(memory.buffer, 8192, 256);
  const end = bytes.indexOf(0);
  assert.notEqual(end, -1, "dlerror output is NUL-terminated");
  return new TextDecoder().decode(bytes.subarray(0, end));
}

function testMemory(address: "i32" | "i64"): WebAssembly.Memory {
  const descriptor =
    address === "i64"
      ? { initial: 2n, maximum: 4n, shared: true, address: "i64" }
      : { initial: 2, maximum: 4, shared: true };
  return new WebAssembly.Memory(descriptor as unknown as WebAssembly.MemoryDescriptor);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errno: number }): T {
  if (!result.ok) assert.fail(`channel operation failed with errno ${result.errno}`);
  return result.value;
}

test("writer publishes a real ProcessDylink group before its constructor runs", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const module = dynamicModule(false, true);
  assert.doesNotThrow(() => new WebAssembly.Module(module));
  const files = new Map([["/plugins/late.so", module]]);
  let hasThread = false;
  let writer!: DylinkWorkerWriter;
  let channel!: DylinkWorkerChannel;
  let owner!: ReturnType<typeof makeProcess>;
  let receiverProcess!: ProcessDylink;
  let barrierChecked = false;
  let constructorLeaseChecked = false;
  let notifyCalls = 0;
  owner = makeProcess(memory, files, {
    postThread: () => hasThread,
    constructorProbe() {
      const state = unwrap(channel.observe());
      assert.equal(state.state, "writing", "cleanup lease spans constructor execution");
      assert.equal(state.cohortSize, 1, "cleanup lease contains only its writer");
      assert.equal(receiver.step().kind, "building", "peer can resume on a cleanup lease");
      const competing = channel.reserve(receiverParticipant);
      assert.equal(competing.ok, false);
      if (!competing.ok) assert.equal(competing.errno, -16);
      assert.equal(
        channel.unregister(receiverParticipant).ok,
        true,
        "peer may exit while owner cleans up",
      );
      constructorLeaseChecked = true;
    },
    beforeInitialize(snapshot, ownerRollback) {
      writer.beforeInitialize(snapshot, ownerRollback);
      assert.equal(
        new DataView(memory.buffer).getUint32(32, true),
        0,
        "constructors have not run at the publication hook",
      );
      assert.equal(unwrap(channel.observe()).state, "writing");
      assert.equal(unwrap(channel.observe()).generation, 1);
      assert.equal(owner.process.getWorkerPublicationState()?.generation, 1);
      assert.equal(receiverProcess.getWorkerPublicationState()?.generation, 1);
      barrierChecked = true;
    },
  });
  const baseline = owner.process.initializeWorkerPublication("writer-process");
  receiverProcess = makeProcess(memory, files, {
    postThread: () => true,
    replay: baseline.snapshot,
    publicationState: baseline,
  }).process;
  channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  const receiverParticipant = unwrap(channel.register());
  const receiver = new DylinkWorkerReceiver(
    channel,
    receiverParticipant,
    receiverProcess,
    (error) => {
      throw error;
    },
  );
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => receiver.step(),
    30_000,
    () => notifyCalls++,
  );

  hasThread = true;
  const pathname = new TextEncoder().encode("/plugins/late.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);
  const handle = writer.open(owner.pathAddress, 2);

  const errorAddress = 8192;
  owner.process.error(errorAddress, 256);
  const errorBytes = new Uint8Array(memory.buffer, errorAddress, 256);
  const errorEnd = errorBytes.indexOf(0);
  const errorMessage = new TextDecoder().decode(errorBytes.subarray(0, errorEnd));
  assert.notEqual(handle, 0, `dlopen failed: ${errorMessage}`);
  assert.equal(barrierChecked, true);
  assert.equal(constructorLeaseChecked, true);
  assert.ok(notifyCalls >= 1, "successful Prepare publication wakes parked Worker checkpoints");
  assert.equal(
    new DataView(memory.buffer).getUint32(32, true),
    1,
    "owner constructor ran after publication finished",
  );
  assert.equal(unwrap(channel.observe()).state, "idle");
  assert.equal(unwrap(channel.observe()).generation, 1);
  assert.equal(receiverProcess.getWorkerPublicationState()?.generation, 1);
  assert.ok(
    receiverProcess
      .getWorkerPublicationState()
      ?.snapshot.files.some((file) => file.path === "/plugins/late.so"),
  );
});

test("writer cancels a reservation when replay preflight rejects before initialization", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const invalidForReplay = dynamicModule(true);
  assert.doesNotThrow(() => new WebAssembly.Module(invalidForReplay));
  let hasThread = false;
  let writer!: DylinkWorkerWriter;
  const owner = makeProcess(memory, new Map([["/plugins/unsupported.so", invalidForReplay]]), {
    postThread: () => hasThread,
    beforeInitialize: (snapshot, ownerRollback) => writer.beforeInitialize(snapshot, ownerRollback),
  });
  const baseline = owner.process.initializeWorkerPublication("preflight-process");
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  unwrap(channel.register());
  let fatalCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      fatalCalls++;
      throw error;
    },
    () => {},
  );
  hasThread = true;
  const pathname = new TextEncoder().encode("/plugins/unsupported.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);

  assert.equal(writer.open(owner.pathAddress, 2), 0);
  assert.deepEqual(unwrap(channel.observe()), {
    state: "idle",
    transaction: null,
    generation: baseline.generation,
    packetLength: 0,
    cohortSize: 0,
    failure: null,
  });
  assert.equal(owner.process.getWorkerPublicationState()?.generation, baseline.generation);
  assert.equal(fatalCalls, 0);
});

test("writer poisons and fatals when the post-Prepare wakeup fails", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  let hasThread = false;
  let writer!: DylinkWorkerWriter;
  const owner = makeProcess(memory, new Map([["/plugins/late.so", dynamicModule()]]), {
    postThread: () => hasThread,
    beforeInitialize: (snapshot) => writer.beforeInitialize(snapshot),
  });
  owner.process.initializeWorkerPublication("notify-failure-process");
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  unwrap(channel.register());
  let fatalCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      fatalCalls++;
      throw error;
    },
    () => {},
    30_000,
    () => {
      throw new Error("Worker wakeup failed");
    },
  );
  hasThread = true;
  const pathname = new TextEncoder().encode("/plugins/late.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);

  assert.throws(() => writer.open(owner.pathAddress, 2));
  assert.equal(unwrap(channel.observe()).state, "poison");
  assert.equal(
    new DataView(memory.buffer).getUint32(32, true),
    0,
    "the constructor must not run after wakeup failure",
  );
  assert.equal(fatalCalls, 1);
});

test("writer deadlines poison a publication that cannot reach a worker barrier", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  let hasThread = false;
  let writer!: DylinkWorkerWriter;
  const owner = makeProcess(memory, new Map([["/plugins/late.so", dynamicModule()]]), {
    postThread: () => hasThread,
    beforeInitialize: (snapshot) => writer.beforeInitialize(snapshot),
  });
  const baseline = owner.process.initializeWorkerPublication("deadline-process");
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  unwrap(channel.register()); // An unresponsive receiver keeps Prepare from advancing.
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => {},
    5,
  );
  const pathname = new TextEncoder().encode("/plugins/late.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);
  hasThread = true;

  assert.throws(() => writer.open(owner.pathAddress, 2));
  assert.equal(unwrap(channel.observe()).state, "poison");
  assert.throws(
    () => owner.process.getWorkerPublicationState(),
    /stale after a process graph change/,
  );
  assert.equal(baseline.generation, 0);
});

test("writer retries a reservation blocked by pending Worker admission", (t) => {
  let tick = 0;
  t.mock.method(performance, "now", () => tick++);
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const module = dynamicModule();
  let hasThread = false;
  let writer!: DylinkWorkerWriter;
  const files = new Map([["/plugins/admitted.so", module]]);
  const owner = makeProcess(memory, files, {
    postThread: () => hasThread,
    beforeInitialize: (snapshot, ownerRollback) => writer.beforeInitialize(snapshot, ownerRollback),
  });
  const baseline = owner.process.initializeWorkerPublication("admission-retry-process");
  const channel = new DylinkWorkerChannel(1 << 20, 3);
  const writerParticipant = unwrap(channel.register());
  const receiverParticipant = unwrap(channel.register());
  const admission = unwrap(channel.beginAdmission());
  const receiverProcess = makeProcess(memory, files, {
    postThread: () => true,
    replay: baseline.snapshot,
    publicationState: baseline,
  }).process;
  const receiver = new DylinkWorkerReceiver(
    channel,
    receiverParticipant,
    receiverProcess,
    (error) => {
      throw error;
    },
  );
  let serviceCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => receiver.step(),
    1_000,
    undefined,
    () => {
      serviceCalls++;
      unwrap(channel.cancelAdmission(admission));
    },
  );

  hasThread = true;
  const pathname = new TextEncoder().encode("/plugins/admitted.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);
  const handle = writer.open(owner.pathAddress, 2);

  assert.notEqual(handle, 0);
  assert.equal(serviceCalls, 1);
  assert.equal(unwrap(channel.observe()).generation, 1);
  assert.equal(owner.process.getWorkerPublicationState()?.generation, 1);
});

test("writer bounds retries while another publication owns the channel", (t) => {
  let tick = 0;
  t.mock.method(performance, "now", () => tick++);
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const files = new Map([["/plugins/late.so", dynamicModule()]]);
  const owner = makeProcess(memory, files);
  const baseline = owner.process.initializeWorkerPublication("busy-channel-process");
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  const blockerParticipant = unwrap(channel.register());
  const blocker = unwrap(channel.reserve(blockerParticipant));
  let serviceCalls = 0;
  let pauseCalls = 0;
  const writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => pauseCalls++,
    5,
    undefined,
    () => serviceCalls++,
  );
  const pathname = new TextEncoder().encode("/plugins/late.so\0");
  new Uint8Array(memory.buffer, 256, pathname.length).set(pathname);

  assert.equal(writer.open(256, 2), 0);
  assert.ok(serviceCalls > 0);
  assert.ok(pauseCalls > 0);
  assert.equal(unwrap(channel.observe()).transaction, blocker.transaction);
  assert.equal(owner.process.getWorkerPublicationState()?.generation, baseline.generation);
  unwrap(channel.cancelReservation(blocker));
});

test("writer timeout keeps maximum diagnostics within dlerror capacity", (t) => {
  let tick = 0;
  t.mock.method(performance, "now", () => tick);
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const owner = makeProcess(memory, new Map([["/plugins/late.so", dynamicModule()]]));
  const baseline = owner.process.initializeWorkerPublication("availability-diagnostic-process");
  const maxU32 = 0xffff_ffff;
  const maxBaseline = { ...baseline, generation: maxU32 };
  t.mock.method(owner.process, "getWorkerPublicationState", () => maxBaseline);
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = { slot: maxU32, epoch: maxU32 };
  let observeCalls = 0;
  t.mock.method(channel, "observe", () => {
    observeCalls++;
    if (observeCalls === 1) return { ok: false as const, errno: -11 };
    return {
      ok: true as const,
      value:
        observeCalls === 2
          ? {
              state: "idle" as const,
              transaction: null,
              generation: maxU32,
              packetLength: 0,
              cohortSize: 0,
              failure: null,
            }
          : {
              state: "writing" as const,
              transaction: maxU32,
              generation: maxU32,
              packetLength: 0,
              cohortSize: maxU32,
              failure: null,
            },
    };
  });
  let reserveCalls = 0;
  t.mock.method(channel, "reserve", () => {
    reserveCalls++;
    return { ok: false as const, errno: -16 };
  });

  let pauseCalls = 0;
  const writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => {
      pauseCalls++;
      tick = pauseCalls === 3 ? 10 : tick + 1;
    },
    10,
  );
  const pathname = new TextEncoder().encode("/plugins/late.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);

  assert.equal(writer.open(owner.pathAddress, 2), 0);
  const error = readDlerror(owner.process, memory, "i32");
  assert.match(error, /^Worker publication timed out waiting for a matching channel generation /);
  assert.match(error, /base=4294967295/);
  assert.match(error, /participant=4294967295\/4294967295/);
  assert.match(error, /(?:last=|o=)writing,tx=4294967295,gen=4294967295,cohort=4294967295/);
  assert.match(error, /(?:oerr|oe)=-11/);
  assert.match(error, /(?:rerr|re)=-16/);
  assert.ok(
    new TextEncoder().encode(error).length <= 255,
    "complete dlerror text leaves room for its NUL byte",
  );
  const rollbackError = `Worker publication was rolled back: ${error}`;
  assert.ok(
    new TextEncoder().encode(rollbackError).length <= 255,
    "diagnostics also fit with the rollback prefix",
  );
  assert.equal(owner.process.recordWorkerPublicationFailure(new Error(rollbackError)), 0);
  assert.equal(readDlerror(owner.process, memory, "i32"), rollbackError);
  assert.ok(!error.includes("/plugins/late.so"), "diagnostics do not expose the requested path");
  assert.equal(baseline.generation, 0);
  assert.equal(reserveCalls, 1);
  assert.equal(observeCalls, 3);
});

test("writer failures replace dlerror and preserve later 32/64-bit opens", (t) => {
  let tick = 0;
  t.mock.method(performance, "now", () => tick++);
  for (const address of ["i32", "i64"] as const) {
    const memory = testMemory(address);
    const module = dynamicModule(false, false, address);
    const files = new Map([["/plugins/late.so", module]]);
    let hasThread = false;
    let serviceReceiver = false;
    let writer!: DylinkWorkerWriter;
    const owner = makeProcess(memory, files, {
      address,
      postThread: () => hasThread,
      beforeInitialize: (snapshot, ownerRollback) =>
        writer.beforeInitialize(snapshot, ownerRollback),
    });
    const baseline = owner.process.initializeWorkerPublication(`error-record-${address}`);
    const channel = new DylinkWorkerChannel(1 << 20, 2);
    const writerParticipant = unwrap(channel.register());
    const receiverParticipant = unwrap(channel.register());
    const receiverProcess = makeProcess(memory, files, {
      address,
      postThread: () => true,
      replay: baseline.snapshot,
      publicationState: baseline,
    }).process;
    const receiver = new DylinkWorkerReceiver(
      channel,
      receiverParticipant,
      receiverProcess,
      (error) => {
        throw error;
      },
    );
    const makeWriter = (timeoutMs: number) =>
      new DylinkWorkerWriter(
        channel,
        writerParticipant,
        owner.process,
        (error) => {
          throw error;
        },
        () => {
          if (serviceReceiver) receiver.step();
        },
        timeoutMs,
      );
    writer = makeWriter(5);
    const wasmWord = (value: number) => (address === "i64" ? BigInt(value) : value);
    const pathname = new TextEncoder().encode("/plugins/late.so\0");
    new Uint8Array(memory.buffer, owner.pathAddress, pathname.length).set(pathname);

    assert.equal(BigInt(owner.process.open(wasmWord(0), 0)), 0n);
    assert.match(readDlerror(owner.process, memory, address), /invalid dlopen mode/);

    const blocker = unwrap(channel.reserve(receiverParticipant));
    hasThread = true;
    const timedOut = writer.open(wasmWord(owner.pathAddress), 2);
    assert.equal(BigInt(timedOut), 0n);
    assert.match(
      readDlerror(owner.process, memory, address),
      /Worker publication timed out waiting for/,
    );
    assert.equal(owner.process.getWorkerPublicationState()?.generation, baseline.generation);

    unwrap(channel.cancelReservation(blocker));
    serviceReceiver = true;
    writer = makeWriter(1_000);
    const handle = writer.open(wasmWord(owner.pathAddress), 2);
    assert.notEqual(
      BigInt(handle),
      0n,
      `a later ${address} open should still succeed: ${readDlerror(owner.process, memory, address)}`,
    );
    assert.equal(unwrap(channel.observe()).state, "idle");
    assert.equal(unwrap(channel.observe()).generation, baseline.generation + 1);
    assert.equal(receiverProcess.getWorkerPublicationState()?.generation, baseline.generation + 1);
  }
});

test("writer starts its barrier deadline after synchronous load and still rolls back timed-out barriers", (t) => {
  let tick = 0;
  t.mock.method(performance, "now", () => tick);

  for (const address of ["i32", "i64"] as const) {
    tick = 0;
    const timeoutMs = 20;
    const memory = testMemory(address);
    const files = new Map([
      ["/plugins/first.so", dynamicModule(false, false, address)],
      ["/plugins/late.so", dynamicModule(false, false, address)],
    ]);
    let hasThread = false;
    let delayBeforeHook = true;
    let pauseBarrier = false;
    let serviceReceiver = true;
    let writer!: DylinkWorkerWriter;
    let channel!: DylinkWorkerChannel;
    let receiver!: DylinkWorkerReceiver;

    const owner = makeProcess(memory, files, {
      address,
      postThread: () => hasThread,
      beforeInitialize(snapshot, ownerRollback) {
        if (delayBeforeHook) tick += timeoutMs * 5;
        writer.beforeInitialize(snapshot, ownerRollback);
      },
    });
    const baseline = owner.process.initializeWorkerPublication(`barrier-deadline-${address}`);
    channel = new DylinkWorkerChannel(1 << 20, 2);
    const writerParticipant = unwrap(channel.register());
    const receiverParticipant = unwrap(channel.register());
    const receiverProcess = makeProcess(memory, files, {
      address,
      postThread: () => true,
      replay: baseline.snapshot,
      publicationState: baseline,
    }).process;
    receiver = new DylinkWorkerReceiver(channel, receiverParticipant, receiverProcess, (error) => {
      throw error;
    });
    writer = new DylinkWorkerWriter(
      channel,
      writerParticipant,
      owner.process,
      (error) => {
        throw error;
      },
      () => {
        const state = unwrap(channel.observe()).state;
        tick += pauseBarrier && state !== "abort" ? timeoutMs + 1 : 1;
        if (serviceReceiver || state === "abort") receiver.step();
      },
      timeoutMs,
    );

    hasThread = true;
    const wasmWord = (value: number) => (address === "i64" ? BigInt(value) : value);
    const firstPath = new TextEncoder().encode("/plugins/first.so\0");
    new Uint8Array(memory.buffer, owner.pathAddress, firstPath.length).set(firstPath);
    const first = writer.open(wasmWord(owner.pathAddress), 2);
    assert.notEqual(
      BigInt(first),
      0n,
      `${address} synchronous pre-hook load should not consume the barrier timeout`,
    );
    assert.equal(unwrap(channel.observe()).generation, baseline.generation + 1);

    delayBeforeHook = false;
    pauseBarrier = true;
    serviceReceiver = false;
    const latePath = new TextEncoder().encode("/plugins/late.so\0");
    new Uint8Array(memory.buffer, owner.pathAddress, latePath.length).set(latePath);
    const timedOut = writer.open(wasmWord(owner.pathAddress), 2);
    assert.equal(BigInt(timedOut), 0n);
    assert.match(
      readDlerror(owner.process, memory, address),
      /Worker publication deadline expired/,
    );
    assert.equal(unwrap(channel.observe()).state, "idle");
    assert.equal(unwrap(channel.observe()).generation, baseline.generation + 1);
    assert.equal(receiverProcess.getWorkerPublicationState()?.generation, baseline.generation + 1);

    pauseBarrier = false;
    serviceReceiver = true;
    delayBeforeHook = true;
    const retry = writer.open(wasmWord(owner.pathAddress), 2);
    assert.notEqual(BigInt(retry), 0n, `${address} retry should succeed after rollback`);
    assert.equal(unwrap(channel.observe()).state, "idle");
    assert.equal(unwrap(channel.observe()).generation, baseline.generation + 2);
    assert.equal(receiverProcess.getWorkerPublicationState()?.generation, baseline.generation + 2);
  }
});

test("writer refreshes its publication baseline after another producer advances the generation", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const files = new Map([
    ["/plugins/first.so", dynamicModule()],
    ["/plugins/late.so", dynamicModule()],
  ]);
  let hasThread = false;
  let hookWriter: DylinkWorkerWriter | null = null;
  const owner = makeProcess(memory, files, {
    postThread: () => hasThread,
    beforeInitialize(snapshot, ownerRollback) {
      assert.ok(hookWriter);
      hookWriter.beforeInitialize(snapshot, ownerRollback);
    },
  });
  const baseline = owner.process.initializeWorkerPublication("generation-retry-process");
  const channel = new DylinkWorkerChannel(1 << 20, 3);
  const waitingParticipant = unwrap(channel.register());
  const producerParticipant = unwrap(channel.register());
  const peerParticipant = unwrap(channel.register());
  const waitingReceiverProcess = makeProcess(memory, files, {
    postThread: () => true,
    replay: baseline.snapshot,
    publicationState: baseline,
  }).process;
  const peerReceiverProcess = makeProcess(memory, files, {
    postThread: () => true,
    replay: baseline.snapshot,
    publicationState: baseline,
  }).process;
  let producerReceiver: DylinkWorkerReceiver | null = null;
  const waitingReceiver = new DylinkWorkerReceiver(
    channel,
    waitingParticipant,
    waitingReceiverProcess,
    (error) => {
      throw error;
    },
  );
  const peerReceiver = new DylinkWorkerReceiver(
    channel,
    peerParticipant,
    peerReceiverProcess,
    (error) => {
      throw error;
    },
  );
  const serviceReceivers = (writerSlot: number) => {
    if (waitingParticipant.slot !== writerSlot) waitingReceiver.step();
    if (producerParticipant.slot !== writerSlot) {
      assert.ok(producerReceiver);
      producerReceiver.step();
    }
    if (peerParticipant.slot !== writerSlot) peerReceiver.step();
  };

  let writer!: DylinkWorkerWriter;
  const producer = new DylinkWorkerWriter(
    channel,
    producerParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => serviceReceivers(producerParticipant.slot),
  );
  let serviceCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    waitingParticipant,
    owner.process,
    (error) => {
      throw error;
    },
    () => serviceReceivers(waitingParticipant.slot),
    1_000,
    undefined,
    () => {
      serviceCalls++;
      assert.equal(serviceCalls, 1);
      unwrap(channel.cancelReservation(blockingReservation));

      const firstPath = new TextEncoder().encode("/plugins/first.so\0");
      new Uint8Array(memory.buffer, owner.pathAddress, firstPath.length).set(firstPath);
      hookWriter = producer;
      assert.notEqual(producer.open(owner.pathAddress, 2), 0);
      const producerBaseline = owner.process.getWorkerPublicationState();
      assert.ok(producerBaseline);
      const producerReceiverProcess = makeProcess(memory, files, {
        postThread: () => true,
        replay: producerBaseline.snapshot,
        publicationState: producerBaseline,
      }).process;
      producerReceiver = new DylinkWorkerReceiver(
        channel,
        producerParticipant,
        producerReceiverProcess,
        (error) => {
          throw error;
        },
      );

      const latePath = new TextEncoder().encode("/plugins/late.so\0");
      new Uint8Array(memory.buffer, owner.pathAddress, latePath.length).set(latePath);
      hookWriter = writer;
    },
  );
  hookWriter = writer;

  // Hold the channel in another producer's Writing state until the service
  // callback releases it and commits a different module generation.
  const blockingReservation = unwrap(channel.reserve(producerParticipant));
  hasThread = true;
  const latePath = new TextEncoder().encode("/plugins/late.so\0");
  new Uint8Array(memory.buffer, owner.pathAddress, latePath.length).set(latePath);
  const handle = writer.open(owner.pathAddress, 2);

  assert.notEqual(handle, 0);
  assert.equal(serviceCalls, 1);
  assert.equal(unwrap(channel.observe()).generation, 2);
  const state = owner.process.getWorkerPublicationState();
  assert.equal(state?.generation, 2);
  assert.ok(state?.snapshot.files.some((file) => file.path === "/plugins/first.so"));
  assert.ok(state?.snapshot.files.some((file) => file.path === "/plugins/late.so"));
});
