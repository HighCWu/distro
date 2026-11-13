// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessDylink } from "../src/dylink_process.ts";
import { DylinkWorkerChannel } from "../src/dylink_worker_channel.ts";
import { DylinkWorkerRuntime } from "../src/dylink_worker_runtime.ts";

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errno: number }): T {
  if (!result.ok) assert.fail(`channel operation failed with errno ${result.errno}`);
  return result.value;
}

function makeProcess(overrides: Record<string, unknown> = {}): ProcessDylink {
  return {
    runAtWorkerCheckpoint<T>(action: () => T) {
      return action();
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
  assert.equal(pauses.length, 0, "idle receiver can resume immediately");

  const reservation = unwrap(channel.reserve(writer));
  runtime.checkpoint();
  assert.equal(pauses.length, 0, "an unpublished writing phase does not block this reader");
  unwrap(channel.cancelReservation(reservation));

  runtime.checkpoint();
  assert.equal(pauses.length, 0);
});

test("runtime preserves the explicit owner route and does not invent a baseline", () => {
  const channel = new DylinkWorkerChannel(1024, 1);
  const participant = unwrap(channel.register());
  const calls: unknown[][] = [];
  const runtime = new DylinkWorkerRuntime({
    shared: channel.shared,
    participant,
    process: makeProcess({
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
  assert.deepEqual(calls, [[64, 2, "", -1]]);
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

  assert.equal(runtime.open(64, 2), 0);
  assert.equal(checkpointCalls, 0, "active owner must not enter receiver checkpoint bookkeeping");
  assert.equal(unwrap(channel.observe()).state, "idle");
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
