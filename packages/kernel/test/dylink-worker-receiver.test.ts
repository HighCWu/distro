// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { ProcessDylink } from "../src/dylink_process.ts";
import { DylinkWorkerChannel } from "../src/dylink_worker_channel.ts";
import { DylinkWorkerSnapshotError } from "../src/dylink_process_worker.ts";
import { create_dylink_worker_publication_delta } from "../src/dylink_worker_publication.ts";
import { DylinkWorkerReceiver } from "../src/dylink_worker_receiver.ts";
import { encode_dylink_worker_publication } from "../src/dylink_worker_transport.ts";

const u32 = (value: number) => {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
};
const wasmText = (value: string) => [
  ...u32(new TextEncoder().encode(value).length),
  ...new TextEncoder().encode(value),
];
const wasmSection = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];
const wasmCustom = (name: string, payload: number[]) =>
  wasmSection(0, [...wasmText(name), ...payload]);

function checkpointLibraryBytes() {
  const dylink = [
    ...wasmSection(1, [0, 0, 0, 0]),
    ...wasmSection(2, [0]),
    ...wasmSection(3, [1, ...wasmText("invoke"), 0]),
    ...wasmSection(4, [1, ...wasmText("env"), ...wasmText("dlsym"), 0]),
  ];
  const imports = [
    5,
    ...wasmText("env"),
    ...wasmText("dlsym"),
    0,
    ...u32(0),
    ...wasmText("env"),
    ...wasmText("memory"),
    2,
    3,
    ...u32(4),
    ...u32(4),
    ...wasmText("env"),
    ...wasmText("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(4),
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
    ...wasmSection(1, [1, 0x60, 0, 1, 0x7f]),
    ...wasmSection(2, imports),
    ...wasmSection(3, [1, 0]),
    ...wasmSection(7, [1, ...wasmText("invoke"), 0, 1]),
    ...wasmSection(10, [1, 4, 0, 0x10, 0, 0x0b]),
  ]);
}

function checkpointMainBytes() {
  const imports = [
    3,
    ...wasmText("env"),
    ...wasmText("host_checkpoint"),
    0,
    ...u32(0),
    ...wasmText("env"),
    ...wasmText("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(4),
    ...u32(4096),
    ...wasmText("env"),
    ...wasmText("__stack_pointer"),
    3,
    0x7f,
    1,
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
    ...wasmSection(1, [1, 0x60, 0, 1, 0x7f]),
    ...wasmSection(2, imports),
    ...wasmSection(3, [1, 0]),
    ...wasmSection(7, [
      3,
      ...wasmText("__indirect_function_table"),
      1,
      0,
      ...wasmText("__stack_pointer"),
      3,
      0,
      ...wasmText("dlsym"),
      0,
      1,
    ]),
    ...wasmSection(9, [1, 0, 0x41, 3, 0x0b, 1, 1]),
    ...wasmSection(10, [1, 4, 0, 0x10, 0, 0x0b]),
  ]);
}

function writeString(memory: WebAssembly.Memory, address: number, value: string) {
  const encoded = new TextEncoder().encode(value);
  new Uint8Array(memory.buffer, address, encoded.length + 1).set([...encoded, 0]);
}

function readString(memory: WebAssembly.Memory, address: number) {
  const bytes = new Uint8Array(memory.buffer);
  let end = address;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(address, end));
}

function makeProcess(options: { queryBlocked?: () => boolean } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 3, maximum: 64 });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 65536);
  let nextAllocation = 1024;
  const callbacks = {
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate(size: number, alignment = 1) {
      const start = Math.ceil(nextAllocation / alignment) * alignment;
      nextAllocation = start + size;
      return nextAllocation <= memory.buffer.byteLength ? start : 0;
    },
  };
  const exports = Object.assign(
    { __indirect_function_table: table, __stack_pointer: stack },
    callbacks,
  );
  const process = new ProcessDylink({
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address: "i32" as const,
    maximumPages: 4,
    tableType: { address: "i32" as const, minimum: 3n, maximum: 64n },
    signatures: new Map<string, string>(),
    privateExports: new Set(Object.keys(callbacks)),
    blocked: () => false,
    ...(options.queryBlocked ? { queryBlocked: options.queryBlocked } : {}),
    isControlFlow: () => false,
    fatal(error: unknown): never {
      throw error;
    },
    pinFile: () => 1,
    unpinFile: () => 0,
  });
  return process;
}

function noOpPublication(process: ProcessDylink, identity: string) {
  const state = process.initializeWorkerPublication(identity);
  return encode_dylink_worker_publication(
    create_dylink_worker_publication_delta(
      state.snapshot,
      state.snapshot,
      identity,
      state.generation,
    ),
  );
}

function makeCheckpointProcess() {
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 4, maximum: 4096 });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 65536);
  const libraryBytes = checkpointLibraryBytes();
  let process!: ProcessDylink;
  let allocation = 16384;
  let currentPath = "";
  let loaderBusyError: unknown;

  const hostCheckpoint = () => {
    const identity = "checkpoint-active-caller";
    process.runAtWorkerCheckpoint(() => finishNoOpAtCheckpoint(process, identity));

    writeString(memory, 12000, "invoke");
    return process.symbol(-1, 12000) === 0 ? 0 : 1;
  };
  const mainInstance = new WebAssembly.Instance(new WebAssembly.Module(checkpointMainBytes()), {
    env: {
      host_checkpoint: hostCheckpoint,
      __indirect_function_table: table,
      __stack_pointer: stack,
    },
  });
  const callbacks = {
    __wasm_dlopen_io_v1: () => 1,
    __wasm_dlopen_allocate(size: number, alignment = 1) {
      const start = Math.ceil(allocation / alignment) * alignment;
      allocation = start + size;
      return allocation <= memory.buffer.byteLength ? start : 0;
    },
    __wasm_dlopen_deallocate: () => {},
    __wasm_dlopen_read(pathPointer: number) {
      try {
        process.runAtWorkerCheckpoint(() => undefined);
      } catch (error) {
        loaderBusyError = error;
      }
      const bytes = new Uint8Array(memory.buffer);
      const end = bytes.indexOf(0, pathPointer);
      currentPath = new TextDecoder().decode(bytes.subarray(pathPointer, end));
      const descriptor = new DataView(memory.buffer);
      descriptor.setBigUint64(512, 2048n, true);
      descriptor.setBigUint64(520, BigInt(libraryBytes.length), true);
      descriptor.setBigUint64(528, 1n, true);
      descriptor.setBigUint64(536, 1n, true);
      descriptor.setBigUint64(544, 0n, true);
      new Uint8Array(memory.buffer, 2048, libraryBytes.length).set(libraryBytes);
      return 512;
    },
    __wasm_dlopen_read_release: () => {},
    __wasm_dlopen_origin() {
      writeString(memory, 1024, currentPath);
      return 1024;
    },
    __wasm_dlopen_fd: () => 3,
    __wasm_dlopen_library_path: () => 0,
    __wasm_dlopen_main_path: () => 0,
  };
  const exports = Object.assign({}, mainInstance.exports, callbacks);
  const privateExports = new Set(Object.keys(callbacks));
  process = new ProcessDylink({
    main: { exports } as unknown as WebAssembly.Instance,
    memory,
    address: "i32" as const,
    maximumPages: 4,
    tableType: { address: "i32" as const, minimum: 4n, maximum: 4096n },
    signatures: new Map([["dlsym", "[[],[127]]"]]),
    privateExports,
    blocked: () => false,
    isControlFlow: () => false,
    fatal(error: unknown): never {
      throw error;
    },
    pinFile: () => 1,
    unpinFile: () => 0,
  });
  return { process, memory, table, getLoaderBusyError: () => loaderBusyError };
}

function finishNoOpAtCheckpoint(process: ProcessDylink, identity: string) {
  const packet = noOpPublication(process, identity);
  const channel = new DylinkWorkerChannel(packet.length, 2);
  const writer = unwrap(channel.register());
  const participant = unwrap(channel.register());
  const receiver = new DylinkWorkerReceiver(channel, participant, process, (error) => {
    throw error;
  });
  const reservation = unwrap(channel.reserve(writer));
  const transaction = reservation.transaction;
  unwrap(channel.publish(reservation, packet));
  assert.deepEqual(receiver.step(), { kind: "phase-acked", transaction, phase: "prepare" });
  unwrap(channel.ack(writer, transaction, "prepare"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "commit");
  assert.deepEqual(receiver.step(), { kind: "phase-acked", transaction, phase: "commit" });
  assert.deepEqual(
    process.runAtWorkerCheckpoint(() => receiver.step()),
    { kind: "phase-acked", transaction, phase: "commit" },
    "a provisional receipt remains accessible at a later checkpoint",
  );
  unwrap(channel.ack(writer, transaction, "commit"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "finalize");
  assert.deepEqual(receiver.step(), { kind: "waiting", transaction, phase: "finalize" });
  unwrap(channel.ack(writer, transaction, "finalize"));
  assert.deepEqual(unwrap(channel.finish(writer, transaction)), { generation: 1, committed: true });
  assert.deepEqual(receiver.step(), { kind: "idle", generation: 1, canResume: true });
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errno: number }): T {
  if (!result.ok) assert.fail(`channel operation failed with errno ${result.errno}`);
  return result.value;
}

test("receiver prepares, provisionally commits, finalizes, and gates resume on Idle", () => {
  const identity = "receiver-integration";
  const process = makeProcess();
  const packet = noOpPublication(process, identity);
  const channel = new DylinkWorkerChannel(packet.length, 2);
  const writer = unwrap(channel.register());
  const receiverParticipant = unwrap(channel.register());
  const fatal: unknown[] = [];
  const receiver = new DylinkWorkerReceiver(channel, receiverParticipant, process, (error) =>
    fatal.push(error),
  );
  const reservation = unwrap(channel.reserve(writer));
  const transaction = reservation.transaction;

  assert.deepEqual(receiver.step(), { kind: "building", generation: 0, canResume: true });
  unwrap(channel.publish(reservation, packet));

  assert.deepEqual(receiver.step(), { kind: "phase-acked", transaction, phase: "prepare" });
  assert.deepEqual(receiver.step(), { kind: "phase-acked", transaction, phase: "prepare" });
  unwrap(channel.ack(writer, transaction, "prepare"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "commit");

  assert.deepEqual(receiver.step(), { kind: "phase-acked", transaction, phase: "commit" });
  assert.deepEqual(receiver.step(), { kind: "phase-acked", transaction, phase: "commit" });
  unwrap(channel.ack(writer, transaction, "commit"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "finalize");

  assert.deepEqual(receiver.step(), { kind: "waiting", transaction, phase: "finalize" });
  assert.deepEqual(receiver.step(), { kind: "waiting", transaction, phase: "finalize" });
  assert.equal(
    unwrap(channel.observe()).state,
    "finalize",
    "the channel remains in Finalize until the writer finishes",
  );
  unwrap(channel.ack(writer, transaction, "finalize"));
  assert.deepEqual(unwrap(channel.finish(writer, transaction)), { generation: 1, committed: true });

  assert.deepEqual(receiver.step(), { kind: "idle", generation: 1, canResume: true });
  assert.equal(process.getWorkerPublicationState()?.generation, 1);
  assert.deepEqual(fatal, []);
});

test("receiver reports malformed publication, then acknowledges Abort without changing ProcessDylink", () => {
  const identity = "receiver-abort";
  const process = makeProcess();
  process.initializeWorkerPublication(identity);
  const channel = new DylinkWorkerChannel(8, 2);
  const writer = unwrap(channel.register());
  const receiverParticipant = unwrap(channel.register());
  const fatal: unknown[] = [];
  const receiver = new DylinkWorkerReceiver(channel, receiverParticipant, process, (error) =>
    fatal.push(error),
  );
  const transaction = unwrap(channel.begin(writer, new Uint8Array([0, 1, 2])));

  assert.deepEqual(receiver.step(), {
    kind: "failure-reported",
    transaction,
    phase: "prepare",
    errno: 22,
  });
  assert.deepEqual(receiver.step(), {
    kind: "failure-reported",
    transaction,
    phase: "prepare",
    errno: 22,
  });
  assert.deepEqual(unwrap(channel.observe()).failure, {
    participant: receiverParticipant,
    errno: 22,
  });
  const rejectedAck = channel.ack(receiverParticipant, transaction, "prepare");
  assert.equal(rejectedAck.ok, false);
  if (!rejectedAck.ok) assert.equal(rejectedAck.errno, -114);

  unwrap(channel.ack(writer, transaction, "prepare"));
  unwrap(channel.requestAbort(writer, transaction));
  assert.deepEqual(receiver.step(), { kind: "waiting", transaction, phase: "abort" });
  unwrap(channel.ack(writer, transaction, "abort"));
  assert.deepEqual(unwrap(channel.finish(writer, transaction)), {
    generation: 0,
    committed: false,
  });
  assert.deepEqual(receiver.step(), { kind: "idle", generation: 0, canResume: true });
  assert.equal(process.getWorkerPublicationState()?.generation, 0);
  assert.deepEqual(fatal, []);
});

test("receiver rolls back a provisional ProcessDylink receipt during Abort", () => {
  const identity = "receiver-rollback";
  const process = makeProcess();
  const packet = noOpPublication(process, identity);
  const channel = new DylinkWorkerChannel(packet.length, 2);
  const writer = unwrap(channel.register());
  const receiverParticipant = unwrap(channel.register());
  const fatal: unknown[] = [];
  const receiver = new DylinkWorkerReceiver(channel, receiverParticipant, process, (error) =>
    fatal.push(error),
  );
  const transaction = unwrap(channel.begin(writer, packet));

  assert.equal(receiver.step().kind, "phase-acked");
  unwrap(channel.ack(writer, transaction, "prepare"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "commit");
  assert.equal(receiver.step().kind, "phase-acked");
  unwrap(channel.requestAbort(writer, transaction));

  assert.deepEqual(receiver.step(), { kind: "waiting", transaction, phase: "abort" });
  unwrap(channel.ack(writer, transaction, "abort"));
  assert.deepEqual(unwrap(channel.finish(writer, transaction)), {
    generation: 0,
    committed: false,
  });
  assert.deepEqual(receiver.step(), { kind: "idle", generation: 0, canResume: true });
  assert.equal(process.getWorkerPublicationState()?.generation, 0);
  assert.deepEqual(fatal, []);
});

test("ProcessDylink checkpoints temporarily clear an active caller and reject loader activity", () => {
  const { process, memory, table, getLoaderBusyError } = makeCheckpointProcess();
  writeString(memory, 256, "/plugins/checkpoint.so");
  const handle = process.open(256, 258); // RTLD_NOW | RTLD_GLOBAL
  if (handle === 0) {
    process.error(14000, 128);
    assert.fail(`dynamic test module should load: ${readString(memory, 14000)}`);
  }
  const busyError = getLoaderBusyError();
  assert.ok(busyError instanceof DylinkWorkerSnapshotError);
  assert.equal(
    busyError.code,
    "EOPNOTSUPP",
    "checkpoint must reject while dlopen holds the loader busy flag",
  );

  writeString(memory, 12000, "invoke");
  const functionAddress = process.symbol(handle, 12000);
  assert.notEqual(functionAddress, 0);
  const invoke = table.get(Number(functionAddress)) as () => number;
  assert.equal(
    invoke(),
    0,
    "RTLD_NEXT inside the imported callback proves the original DSO caller was restored",
  );
  assert.equal(
    process.getWorkerPublicationState()?.generation,
    1,
    "receiver metadata update runs at the checkpoint",
  );
});

test("ProcessDylink checkpoints reject a vfork-blocked query context", () => {
  const process = makeProcess({ queryBlocked: () => true });
  assert.throws(
    () => process.runAtWorkerCheckpoint(() => 1),
    (error) => error instanceof DylinkWorkerSnapshotError && error.code === "EOPNOTSUPP",
  );
});
