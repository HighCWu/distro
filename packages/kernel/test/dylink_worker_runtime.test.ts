// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessDylink } from "../src/dylink_process.ts";
import { DylinkWorkerChannel } from "../src/dylink_worker_channel.ts";
import { DylinkWorkerRuntime } from "../src/dylink_worker_runtime.ts";
import { encode_dylink_worker_publication } from "../src/dylink_worker_transport.ts";

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errno: number }): T {
  if (!result.ok) assert.fail(`channel operation failed with errno ${result.errno}`);
  return result.value;
}

function makeProcess(overrides: Record<string, unknown> = {}): ProcessDylink {
  return {
    runAtWorkerCheckpoint<T>(action: () => T) {
      return action();
    },
    recordWorkerPublicationFailure(_error: unknown, _message?: string) {
      return 0;
    },
    getWorkerPublicationState: () => null,
    openWithWorkerPublication: (path: number | bigint) => (typeof path === "bigint" ? 0n : 0),
    ...overrides,
  } as unknown as ProcessDylink;
}

test("runtime checkpoint returns only when its participant can resume", () => {
  const channel = new DylinkWorkerChannel(1024, 2);
  const participant = unwrap(channel.register());
  const writer = unwrap(channel.register());
  const pauses: number[] = [];
  const runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant,
    process: makeProcess(),
    fatal(error) {
      throw error;
    },
    notify() {},
    pause() {
      pauses.push(1);
    },
  });

  runtime.checkpoint();
  assert.equal(runtime.kernelCheckpointStep(), 1, "an idle runtime still advertises recheck work");
  assert.equal(runtime.kernelCheckpointDeferredStatus(), 1);
  assert.equal(pauses.length, 0, "idle receiver can resume immediately");

  const reservation = unwrap(channel.reserve(writer));
  runtime.checkpoint();
  assert.equal(pauses.length, 0, "an unpublished writing phase does not block this reader");
  assert.equal(runtime.kernelCheckpointStep(), 1, "a building writer is a resumable source");
  unwrap(channel.cancelReservation(reservation));

  runtime.checkpoint();
  assert.equal(pauses.length, 0);
});

test("runtime preserves the explicit owner route and does not invent a baseline", () => {
  const channel = new DylinkWorkerChannel(1024, 1);
  const participant = unwrap(channel.register());
  const calls: unknown[][] = [];
  let failure: { error: unknown; message?: string } | undefined;
  const runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant,
    process: makeProcess({
      recordWorkerPublicationFailure(error: unknown, message?: string) {
        failure = { error, message };
        return 0;
      },
      openWithWorkerPublication(
        path: number | bigint,
        flags: number,
        identity: string,
        generation: number,
      ) {
        calls.push([path, flags, identity, generation]);
        return typeof path === "bigint" ? 0n : 0;
      },
    }),
    fatal(error) {
      throw error;
    },
    notify() {},
    pause() {},
  });

  assert.equal(runtime.open(64, 2), 0);
  assert.deepEqual(calls, [], "the owner path is not entered without a published baseline");
  assert.equal(failure?.message, undefined);
  assert.equal(
    failure?.error instanceof Error ? failure.error.message : "",
    "Worker publication baseline is unavailable",
  );
});

test("runtime does not service its receiver from its active producer", () => {
  const channel = new DylinkWorkerChannel(1024, 1);
  const participant = unwrap(channel.register());
  let runtime!: DylinkWorkerRuntime;
  let checkpointCalls = 0;
  const process = makeProcess({
    getWorkerPublicationState: () => ({
      processIdentity: "process",
      generation: 0,
      snapshot: { address: "i32" },
    }),
    runAtWorkerCheckpoint<T>(action: () => T) {
      checkpointCalls++;
      return action();
    },
    openWithWorkerPublication(path: number | bigint) {
      assert.equal(runtime.writerActive, true, "the getter reflects the producer wait");
      assert.equal(runtime.kernelCheckpointStep(), 1);
      runtime.checkpoint();
      return typeof path === "bigint" ? 0n : 0;
    },
  });
  runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant,
    process,
    fatal(error) {
      throw error;
    },
    notify() {},
    pause() {},
  });

  assert.equal(runtime.writerActive, false);
  assert.equal(runtime.open(64, 2), 0);
  assert.equal(runtime.writerActive, false, "completed producer releases its active state");
  assert.equal(checkpointCalls, 0, "active owner must not enter receiver checkpoint bookkeeping");
  assert.equal(unwrap(channel.observe()).state, "idle");
});

test("kernel checkpoint performs one step and keeps a prepared receiver parked", (t) => {
  const channel = new DylinkWorkerChannel(1024, 2);
  const receiver = unwrap(channel.register());
  const writer = unwrap(channel.register());
  const acknowledge = DylinkWorkerChannel.prototype.ack;
  let retryAcknowledgement = true;
  t.mock.method(
    DylinkWorkerChannel.prototype,
    "ack",
    function (this: DylinkWorkerChannel, ...args: Parameters<DylinkWorkerChannel["ack"]>) {
      if (retryAcknowledgement && args[0].slot === receiver.slot) {
        retryAcknowledgement = false;
        return { ok: false, errno: -16 } as const;
      }
      return acknowledge.apply(this, args);
    },
  );
  const packet = encode_dylink_worker_publication({} as never);
  let boundaryCalls = 0;
  let prepareCalls = 0;
  const runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant: receiver,
    process: makeProcess({
      runAtWorkerCheckpoint<T>(action: () => T) {
        boundaryCalls++;
        return action();
      },
      prepareWorkerExtension() {
        prepareCalls++;
        return {};
      },
    }),
    fatal(error) {
      throw error;
    },
    notify() {},
    pause() {
      assert.fail("single-step checkpoint must not pause");
    },
  });

  unwrap(channel.begin(writer, packet));
  assert.equal(runtime.kernelCheckpointDeferredStatus(), 1);
  assert.equal(boundaryCalls, 0, "an unprepared receiver defers without acknowledging");
  assert.equal(runtime.kernelCheckpointStep(), 2);
  assert.equal(boundaryCalls, 1);
  assert.equal(prepareCalls, 1);
  assert.equal(retryAcknowledgement, false, "prepare succeeded before its acknowledgement retried");
  assert.equal(runtime.kernelCheckpointDeferredStatus(), 2);
  assert.equal(boundaryCalls, 1, "guarded status observes but does not step the receiver");
  assert.equal(runtime.kernelCheckpointStep(), 2);
  assert.equal(prepareCalls, 1, "acknowledgement retry must not repeat module preparation");
  assert.equal(unwrap(channel.observe()).state, "prepare");
});

test("kernel checkpoint deadline is absolute for one prepared transaction", (t) => {
  let clock = 0;
  t.mock.method(performance, "now", () => clock);

  const channel = new DylinkWorkerChannel(1024, 2);
  const receiver = unwrap(channel.register());
  const writer = unwrap(channel.register());
  const packet = encode_dylink_worker_publication({} as never);
  let boundaryCalls = 0;
  const runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant: receiver,
    process: makeProcess({
      runAtWorkerCheckpoint<T>(action: () => T) {
        boundaryCalls++;
        return action();
      },
      prepareWorkerExtension: () => ({}),
    }),
    fatal(error) {
      throw error;
    },
    notify() {},
    pause() {
      assert.fail("kernel checkpoint must not pause");
    },
    timeoutMs: 30,
  });

  unwrap(channel.begin(writer, packet));
  assert.equal(runtime.kernelCheckpointStep(), 2);
  clock = 20;
  assert.equal(runtime.kernelCheckpointStep(), 2, "repeated steps retain the original deadline");
  clock = 29;
  assert.equal(runtime.kernelCheckpointDeferredStatus(), 2);
  clock = 31;
  assert.throws(
    () => runtime.kernelCheckpointDeferredStatus(),
    /Worker receiver checkpoint deadline expired/,
  );
  assert.equal(boundaryCalls, 2, "deferred checks do not run receiver steps");
});

test("runtime invokes its fatal callback once after checkpoint failure", () => {
  const channel = new DylinkWorkerChannel(1024, 1);
  const participant = unwrap(channel.register());
  const failure = new Error("checkpoint unavailable");
  let fatalCalls = 0;
  const runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant,
    process: makeProcess({
      runAtWorkerCheckpoint() {
        throw failure;
      },
    }),
    fatal(error) {
      fatalCalls++;
      assert.equal(error, failure);
      throw error;
    },
    notify() {},
    pause() {},
  });

  assert.throws(() => runtime.checkpoint(), failure);
  assert.throws(() => runtime.checkpoint(), /already failed/);
  assert.equal(fatalCalls, 1);
});
