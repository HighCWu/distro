// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { DylinkWorkerChannel, type DylinkWorkerReservation } from "../src/dylink_worker_channel.ts";
import { ProcessDylink } from "../src/dylink_process.ts";
import { DylinkWorkerReceiver } from "../src/dylink_worker_receiver.ts";
import { DylinkWorkerPublicationAbort } from "../src/dylink_worker_abort.ts";
import {
  coordinateDylinkWorkerAbort,
  createDylinkWorkerAbortDeadline,
} from "../src/dylink_worker_abort_coordinator.ts";
import { DylinkWorkerWriter } from "../src/dylink_worker_writer.ts";
import type { DylinkWorkerSnapshot } from "../src/dylink_process_worker.ts";

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value & 0x7f;
    value >>>= 7;
    bytes.push(next | (value === 0 ? 0 : 0x80));
  } while (value !== 0);
  return bytes;
}

const wasmText = (value: string) => [
  ...u32(new TextEncoder().encode(value).length),
  ...new TextEncoder().encode(value),
];
const wasmSection = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];
const wasmCustom = (name: string, payload: number[]) =>
  wasmSection(0, [...wasmText(name), ...payload]);
const wasmSubsection = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];

function dynamicModule(): Uint8Array<ArrayBuffer> {
  const dylink = [
    ...wasmSubsection(1, [...u32(0), ...u32(0), ...u32(0), ...u32(0)]),
    ...wasmSubsection(2, [0]),
    ...wasmSubsection(3, [
      2,
      ...wasmText("__wasm_call_ctors"),
      ...u32(0),
      ...wasmText("answer"),
      ...u32(0),
    ]),
    ...wasmSubsection(4, [0]),
  ];
  const imports = [
    4,
    ...wasmText("env"),
    ...wasmText("memory"),
    2,
    3,
    ...u32(1),
    ...u32(4),
    ...wasmText("env"),
    ...wasmText("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(3),
    ...u32(4096),
    ...wasmText("env"),
    ...wasmText("__memory_base"),
    3,
    0x7f,
    0,
    ...wasmText("env"),
    ...wasmText("__table_base"),
    3,
    0x7f,
    0,
  ];
  const ctor = [0, 0x41, 32, 0x41, 32, 0x28, 2, 0, 0x41, 1, 0x6a, 0x36, 2, 0, 0x0b];
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
    ...wasmCustom("dylink.0", dylink),
    ...wasmSection(1, [2, 0x60, 0, 0, 0x60, 0, 1, 0x7f]),
    ...wasmSection(2, imports),
    ...wasmSection(3, [2, 0, 1]),
    ...wasmSection(7, [2, ...wasmText("__wasm_call_ctors"), 0, 0, ...wasmText("answer"), 0, 1]),
    ...wasmSection(10, [2, ...u32(ctor.length), ...ctor, ...u32(answer.length), ...answer]),
  ]);
}

function makeProcess(
  memory: WebAssembly.Memory,
  files: ReadonlyMap<string, Uint8Array<ArrayBuffer>>,
  options: {
    postThread?: () => boolean;
    beforeInitialize?: (snapshot: DylinkWorkerSnapshot) => void;
    replay?: DylinkWorkerSnapshot;
    publicationState?: {
      processIdentity: string;
      generation: number;
      snapshot: DylinkWorkerSnapshot;
    };
  } = {},
): { process: ProcessDylink; pathAddress: number } {
  const mainModule = new WebAssembly.Module(
    new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      ...wasmSection(4, [1, 0x70, 1, ...u32(3), ...u32(4096)]),
      ...wasmSection(6, [1, 0x7f, 1, 0x41, 0, 0x0b]),
      ...wasmSection(7, [
        2,
        ...wasmText("__indirect_function_table"),
        1,
        0,
        ...wasmText("__stack_pointer"),
        3,
        0,
      ]),
    ]),
  );
  const main = new WebAssembly.Instance(mainModule);
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
      descriptor.setBigUint64(descriptorAddress + 24, 1n, true);
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
    signatures: new Map(),
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
  return { process, pathAddress: 256 };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errno: number }): T {
  if (!result.ok) assert.fail(`channel operation failed with errno ${result.errno}`);
  return result.value;
}

function enterCommit(
  channel: DylinkWorkerChannel,
  reservation: DylinkWorkerReservation,
  writer: { slot: number; epoch: number },
  peer: { slot: number; epoch: number },
): void {
  unwrap(channel.publish(reservation, new Uint8Array([1, 2, 3])));
  unwrap(channel.ack(peer, reservation.transaction, "prepare"));
  unwrap(channel.ack(writer, reservation.transaction, "prepare"));
  unwrap(channel.advance(writer, reservation.transaction));
}

test("abort waits for the whole cohort and finishes without advancing generation", () => {
  const channel = new DylinkWorkerChannel(64, 2);
  const writer = unwrap(channel.register());
  const peer = unwrap(channel.register());
  const reservation = unwrap(channel.reserve(writer));
  enterCommit(channel, reservation, writer, peer);
  // Model a peer that provisionally committed before the writer decided to
  // abort. Abort resets phase acknowledgements and requires a fresh cohort ack.
  unwrap(channel.ack(peer, reservation.transaction, "commit"));

  let notifications = 0;
  let peerRolledBack = false;
  const cleanupLease = coordinateDylinkWorkerAbort({
    channel,
    writer,
    reservation,
    deadline: createDylinkWorkerAbortDeadline(100),
    notify: () => notifications++,
    pause: () => {
      if (!peerRolledBack && unwrap(channel.observe()).state === "abort") {
        unwrap(channel.ack(peer, reservation.transaction, "abort"));
        peerRolledBack = true;
      }
    },
  });

  assert.equal(peerRolledBack, true);
  assert.equal(unwrap(channel.observe()).state, "writing");
  assert.notEqual(cleanupLease.transaction, reservation.transaction);
  unwrap(channel.cancelReservation(cleanupLease));
  notifications++;
  assert.equal(notifications, 2);
  assert.deepEqual(unwrap(channel.observe()), {
    state: "idle",
    transaction: null,
    generation: reservation.generation,
    packetLength: 0,
    cohortSize: 0,
    failure: null,
  });
});

test("abort refuses to roll back after the channel entered Finalize", () => {
  const channel = new DylinkWorkerChannel(64, 2);
  const writer = unwrap(channel.register());
  const peer = unwrap(channel.register());
  const reservation = unwrap(channel.reserve(writer));
  enterCommit(channel, reservation, writer, peer);
  unwrap(channel.ack(peer, reservation.transaction, "commit"));
  unwrap(channel.ack(writer, reservation.transaction, "commit"));
  unwrap(channel.advance(writer, reservation.transaction));

  assert.throws(
    () =>
      coordinateDylinkWorkerAbort({
        channel,
        writer,
        reservation,
        deadline: createDylinkWorkerAbortDeadline(100),
        notify: () => {},
        pause: () => {},
      }),
    /cannot abort Worker publication in finalize/,
  );
  assert.equal(unwrap(channel.observe()).state, "finalize");
});

test("an unpublished reservation is cancelled without changing the cohort generation", () => {
  const channel = new DylinkWorkerChannel(64, 1);
  const writer = unwrap(channel.register());
  const reservation = unwrap(channel.reserve(writer));
  let notifications = 0;

  let ownerRestored = false;
  const cleanupLease = coordinateDylinkWorkerAbort({
    channel,
    writer,
    reservation,
    deadline: createDylinkWorkerAbortDeadline(100),
    notify: () => notifications++,
    pause: () => {},
    beforeRelease: () => {
      ownerRestored = true;
    },
  });

  assert.equal(ownerRestored, true);
  assert.deepEqual(unwrap(channel.observe()).state, "writing");
  assert.equal(cleanupLease.transaction, reservation.transaction);
  unwrap(channel.cancelReservation(cleanupLease));
  notifications++;
  assert.equal(notifications, 1);
  assert.deepEqual(unwrap(channel.observe()), {
    state: "idle",
    transaction: null,
    generation: reservation.generation,
    packetLength: 0,
    cohortSize: 0,
    failure: null,
  });
});

test("writer restores and releases owner state only after the receiver abort barrier", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const module = dynamicModule();
  const files = new Map([["/plugins/late.so", module]]);
  let writer!: DylinkWorkerWriter;
  const baselineProcess = makeProcess(memory, files).process;
  const baseline = baselineProcess.initializeWorkerPublication("abort-owner-process");
  const targetBuilder = makeProcess(memory, files);
  new Uint8Array(memory.buffer, targetBuilder.pathAddress, 17).set(
    new TextEncoder().encode("/plugins/late.so\0"),
  );
  assert.notEqual(targetBuilder.process.open(targetBuilder.pathAddress, 2), 0);
  const target = targetBuilder.process.initializeWorkerPublication("abort-owner-process");
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  const receiverParticipant = unwrap(channel.register());
  const receiverProcess = makeProcess(memory, files, {
    postThread: () => true,
    replay: baseline.snapshot,
    publicationState: baseline,
  }).process;
  const order: string[] = [];
  const rollbackExtension = receiverProcess.rollbackWorkerExtension.bind(receiverProcess);
  receiverProcess.rollbackWorkerExtension = (receipt) => {
    order.push("receiver-rollback");
    rollbackExtension(receipt);
  };
  const receiver = new DylinkWorkerReceiver(
    channel,
    receiverParticipant,
    receiverProcess,
    (error) => {
      throw error;
    },
  );
  const originalObserve = channel.observe.bind(channel);
  let ownerState = baseline;
  let transactionBeforeAbort: number | null = null;
  const token = {
    restore() {
      order.push("restore");
      ownerState = baseline;
    },
    release() {
      order.push("release");
      const cleanup = unwrap(originalObserve());
      assert.equal(cleanup.state, "writing", "owner frees allocations under the cleanup lease");
      assert.equal(cleanup.cohortSize, 1, "cleanup lease excludes the exited receiver");
      assert.notEqual(transactionBeforeAbort, null);
      assert.notEqual(cleanup.transaction, transactionBeforeAbort);
      const competing = channel.reserve(receiverParticipant);
      assert.equal(competing.ok, false);
      if (!competing.ok) assert.equal(competing.errno, -16);
    },
    commit() {
      order.push("commit");
    },
  };
  let consumedAbort = false;
  const processStub = {
    getWorkerPublicationState: () => ownerState,
    advanceWorkerPublicationBeforeInitialize(
      processIdentity: string,
      generation: number,
      snapshot: DylinkWorkerSnapshot,
    ) {
      assert.equal(processIdentity, baseline.processIdentity);
      assert.equal(generation, baseline.generation);
      ownerState = {
        processIdentity,
        generation: generation + 1,
        snapshot,
      };
    },
    openWithWorkerPublication: () => {
      try {
        writer.beforeInitialize(target.snapshot, token);
      } catch (error) {
        if (!(error instanceof DylinkWorkerPublicationAbort)) throw error;
        consumedAbort = true;
        return 0;
      }
      return 0;
    },
  } as unknown as ProcessDylink;
  let notifyCalls = 0;
  let commitFailureInjected = false;
  channel.observe = () => {
    const observed = originalObserve();
    if (
      !commitFailureInjected &&
      observed.ok &&
      observed.value.state === "commit" &&
      ownerState.generation === baseline.generation + 1
    ) {
      commitFailureInjected = true;
      assert.equal(
        receiver.step().kind,
        "phase-acked",
        "the receiver holds a provisional receipt before the synthetic Commit failure",
      );
      unwrap(channel.reportFailure(receiverParticipant, observed.value.transaction!, 95));
      return originalObserve();
    }
    return observed;
  };
  let fatalCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    processStub,
    (error) => {
      fatalCalls++;
      throw error;
    },
    () => {
      receiver.step();
    },
    30_000,
    () => {
      notifyCalls++;
      const observed = originalObserve();
      if (observed.ok && observed.value.state === "prepare")
        transactionBeforeAbort = observed.value.transaction;
    },
  );
  assert.equal(writer.open(0, 2), 0);
  assert.equal(
    consumedAbort,
    true,
    "ProcessDylink consumes the abort brand and returns a null handle",
  );
  assert.deepEqual(order, ["receiver-rollback", "restore", "release"]);
  assert.equal(commitFailureInjected, true);
  assert.ok(notifyCalls >= 2);
  assert.equal(ownerState.generation, baseline.generation);
  assert.equal(fatalCalls, 0);
  assert.equal(unwrap(channel.observe()).state, "idle");
  assert.equal(unwrap(channel.observe()).generation, baseline.generation);
  assert.equal(
    receiverProcess
      .getWorkerPublicationState()
      ?.snapshot.files.some((file) => file.path === "/plugins/late.so"),
    false,
    "the receiver rolls back its provisional group before acknowledging abort",
  );
});

test("writer fatals if ProcessDylink leaks the branded abort instead of returning null", () => {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const baseline = makeProcess(memory, new Map()).process.initializeWorkerPublication(
    "leaked-abort-brand",
  );
  const channel = new DylinkWorkerChannel(1 << 20, 2);
  const writerParticipant = unwrap(channel.register());
  const peer = unwrap(channel.register());
  let writer!: DylinkWorkerWriter;
  const rollbackOrder: string[] = [];
  const token = {
    restore() {
      rollbackOrder.push("restore");
    },
    release() {
      rollbackOrder.push("release");
    },
    commit() {
      rollbackOrder.push("commit");
    },
  };
  const processStub = {
    getWorkerPublicationState: () => baseline,
    openWithWorkerPublication: () => {
      writer.beforeInitialize(baseline.snapshot, token);
      return 0;
    },
  } as unknown as ProcessDylink;
  let notifications = 0;
  let fatalCalls = 0;
  writer = new DylinkWorkerWriter(
    channel,
    writerParticipant,
    processStub,
    (error) => {
      fatalCalls++;
      throw error;
    },
    () => {
      if (unwrap(channel.observe()).state === "abort") {
        const observed = unwrap(channel.observe());
        unwrap(channel.ack(peer, observed.transaction!, "abort"));
      }
    },
    30_000,
    () => {
      notifications++;
      if (notifications === 1) throw new Error("Prepare notification failed");
    },
  );

  assert.throws(() => writer.open(0, 2), /Worker publication was rolled back/);
  assert.equal(fatalCalls, 1);
  assert.deepEqual(rollbackOrder, ["restore", "release"]);
  assert.equal(unwrap(channel.observe()).state, "idle");
  assert.equal(unwrap(channel.observe()).generation, baseline.generation);
});
