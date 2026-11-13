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
function dynamicModule(mutableGlobal = false, constructorProbe = false): Uint8Array<ArrayBuffer> {
  const functionIndexOffset = constructorProbe ? 1 : 0;
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
    ...(constructorProbe ? [...text("env"), ...text("__worker_publication_ctor_probe"), 0, 0] : []),
  ];
  const ctor = [
    0,
    ...(constructorProbe ? [0x10, 0] : []),
    0x41,
    32,
    0x41,
    32,
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

function mainModule(): Uint8Array<ArrayBuffer> {
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
      3,
      ...u32(2),
      ...u32(4),
      ...text("env"),
      ...text("__worker_publication_ctor_probe"),
      0,
      0,
    ]),
    ...section(3, [1, 0]),
    ...section(4, [1, 0x70, 1, ...u32(3), ...u32(4096)]),
    ...section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]),
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
  } = {},
) {
  const main = new WebAssembly.Instance(new WebAssembly.Module(mainModule()), {
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
    __wasm_dlopen_allocate(size: number, alignment = 1) {
      const aligned = Math.ceil(allocation / alignment) * alignment;
      allocation = aligned + size;
      return allocation <= memory.buffer.byteLength ? aligned : 0;
    },
    __wasm_dlopen_deallocate: () => {},
    __wasm_dlopen_read(pathPointer: number) {
      const bytes = new Uint8Array(memory.buffer);
      let end = pathPointer;
      while (end < bytes.length && bytes[end] !== 0) end++;
      currentPath = new TextDecoder().decode(bytes.subarray(pathPointer, end));
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
  const exports = Object.assign({}, main.exports, callbacks);
  const process = new ProcessDylink({
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address: "i32",
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

test("writer retries a reservation blocked by pending Worker admission", () => {
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

test("writer bounds retries while another publication owns the channel", () => {
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
