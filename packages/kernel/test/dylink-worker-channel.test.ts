// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import {
  DylinkWorkerChannel,
  type DylinkWorkerChannelPhase,
  type DylinkWorkerParticipant,
} from "../src/dylink_worker_channel.ts";

const workerSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  (async () => {
    const { DylinkWorkerChannel } = await import(workerData.module);
    const channel = DylinkWorkerChannel.attach(workerData.shared);
    const registered = channel.register();
    parentPort.postMessage({ type: "registered", result: registered });
    if (!registered.ok) return;
    const token = registered.value;
    parentPort.on("message", (message) => {
      let result;
      if (message.operation === "read") {
        const read = channel.readPacket(token, message.transaction);
        result = read.ok ? { ok: true, bytes: [...read.value] } : read;
      } else if (message.operation === "ack") {
        result = channel.ack(token, message.transaction, message.phase);
      } else if (message.operation === "unregister") {
        result = channel.unregister(token);
      } else {
        result = { ok: false, errno: -22 };
      }
      parentPort.postMessage({ type: "reply", id: message.id, result });
    });
  })().catch((error) => { throw error; });
`;

function unwrap<T>(result: { ok: true; value: T } | { ok: false; errno: number }): T {
  if (!result.ok) assert.fail(`channel operation failed with errno ${result.errno}`);
  return result.value;
}

function errorNumber(result: { ok: true; value: unknown } | { ok: false; errno: number }): number {
  if (result.ok) assert.fail("expected channel operation to fail");
  return result.errno;
}

async function workerRequest(
  worker: Worker,
  id: number,
  operation: "read" | "ack" | "unregister",
  transaction?: number,
  phase?: DylinkWorkerChannelPhase,
): Promise<any> {
  const response = once(worker, "message");
  worker.postMessage({ id, operation, transaction, phase });
  const [message] = await response;
  assert.equal(message.type, "reply");
  assert.equal(message.id, id);
  return message.result;
}

async function workerAck(
  worker: Worker,
  id: number,
  transaction: number,
  phase: DylinkWorkerChannelPhase,
): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await workerRequest(worker, id + attempt, "ack", transaction, phase);
    if (!result || result.errno !== -16) return result;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Worker channel ack remained contended");
}

async function makeWorker(
  channel: DylinkWorkerChannel,
): Promise<{ worker: Worker; token: DylinkWorkerParticipant }> {
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      module: new URL("../src/dylink_worker_channel.ts", import.meta.url).href,
      shared: channel.shared,
    },
  });
  const [message] = await once(worker, "message");
  assert.equal(message.type, "registered");
  const token = unwrap(
    message.result as { ok: true; value: DylinkWorkerParticipant } | { ok: false; errno: number },
  );
  return { worker, token };
}

test("Worker channel freezes a cohort, rejects late acks, aborts, and reuses the next transaction", async (t) => {
  const channel = new DylinkWorkerChannel(128, 3);
  const writer = unwrap(channel.register());
  const first = await makeWorker(channel);
  const second = await makeWorker(channel);
  t.after(async () => {
    await Promise.all([first.worker.terminate(), second.worker.terminate()]);
  });

  const original = new Uint8Array([0x44, 0x57, 0x50, 0x55, 1, 2, 3]);
  const began = unwrap(channel.begin(writer, original));
  original.fill(0xff);
  assert.equal(channel.register().ok, false, "participants cannot join a captured cohort");
  assert.equal((await workerRequest(first.worker, 1, "unregister")).errno, -16);

  for (const worker of [first.worker, second.worker]) {
    const read = await workerRequest(worker, 2, "read", began);
    assert.deepEqual(read.bytes, [0x44, 0x57, 0x50, 0x55, 1, 2, 3]);
  }
  const prepareAcks = await Promise.all([
    workerAck(first.worker, 3, began, "prepare"),
    workerAck(second.worker, 3, began, "prepare"),
  ]);
  assert.ok(prepareAcks.every((ack) => ack.ok));
  assert.equal(
    errorNumber(channel.advance(writer, began)),
    -11,
    "writer must also acknowledge Prepare",
  );
  unwrap(channel.ack(writer, began, "prepare"));
  assert.equal(unwrap(channel.advance(writer, began)), "commit");
  assert.equal((await workerRequest(first.worker, 4, "ack", began, "prepare")).errno, -116);

  unwrap(channel.ack(writer, began, "commit"));
  await Promise.all([
    workerAck(first.worker, 5, began, "commit"),
    workerAck(second.worker, 5, began, "commit"),
  ]).then((acks) =>
    assert.ok(
      acks.every((ack) => ack.ok),
      JSON.stringify(acks),
    ),
  );
  assert.equal(unwrap(channel.advance(writer, began)), "finalize");
  unwrap(channel.ack(writer, began, "finalize"));
  unwrap(await workerAck(first.worker, 6, began, "finalize"));
  assert.equal(
    errorNumber(channel.finish(writer, began)),
    -11,
    "generation waits for every Finalize acknowledgement",
  );
  await Promise.all([workerAck(second.worker, 7, began, "finalize")]).then((acks) =>
    assert.ok(
      acks.every((ack) => ack.ok),
      JSON.stringify(acks),
    ),
  );
  assert.deepEqual(unwrap(channel.finish(writer, began)), { generation: 1, committed: true });

  const aborted = unwrap(channel.begin(writer, new Uint8Array([9, 8, 7])));
  unwrap(channel.requestAbort(writer, aborted));
  unwrap(channel.ack(writer, aborted, "abort"));
  const abortAcks = await Promise.all([
    workerAck(first.worker, 7, aborted, "abort"),
    workerAck(second.worker, 7, aborted, "abort"),
  ]);
  assert.ok(
    abortAcks.every((ack) => ack.ok),
    JSON.stringify(abortAcks),
  );
  assert.deepEqual(unwrap(channel.finish(writer, aborted)), { generation: 1, committed: false });

  const next = unwrap(channel.begin(writer, new Uint8Array([3, 2, 1])));
  assert.ok(next > aborted);
  assert.deepEqual(unwrap(channel.observe()), {
    state: "prepare",
    transaction: next,
    generation: 1,
    packetLength: 3,
    cohortSize: 3,
    failure: null,
  });
  unwrap(channel.requestAbort(writer, next));
  unwrap(channel.ack(writer, next, "abort"));
  await Promise.all([
    workerAck(first.worker, 8, next, "abort"),
    workerAck(second.worker, 8, next, "abort"),
  ]).then((acks) =>
    assert.ok(
      acks.every((ack) => ack.ok),
      JSON.stringify(acks),
    ),
  );
  assert.deepEqual(unwrap(channel.finish(writer, next)), { generation: 1, committed: false });
});

test("Worker channel epochs reject stale participant tokens and poison is permanent", () => {
  const channel = new DylinkWorkerChannel(0, 1);
  const oldToken = unwrap(channel.register());
  unwrap(channel.unregister(oldToken));
  const newToken = unwrap(channel.register());
  assert.equal(newToken.slot, oldToken.slot);
  assert.ok(newToken.epoch > oldToken.epoch);
  assert.equal(errorNumber(channel.begin(oldToken, new Uint8Array())), -116);

  const transaction = unwrap(channel.begin(newToken, new Uint8Array()));
  unwrap(channel.poison(newToken, transaction));
  assert.equal(unwrap(channel.observe()).state, "poison");
  assert.equal(errorNumber(channel.register()), -95);
  assert.equal(errorNumber(channel.begin(newToken, new Uint8Array())), -95);
});

test("writer reservation blocks graph races and can cancel before publishing", () => {
  const channel = new DylinkWorkerChannel(8, 3);
  const writer = unwrap(channel.register());
  const existingWorker = unwrap(channel.register());
  const reservation = unwrap(channel.reserve(writer));

  assert.equal(unwrap(channel.observe()).state, "writing");
  assert.equal(
    errorNumber(channel.register()),
    -16,
    "new participants cannot enter the reserved cohort",
  );
  assert.equal(
    errorNumber(channel.reserve(writer)),
    -16,
    "a second producer cannot acquire the writer lease",
  );
  assert.equal(
    errorNumber(channel.unregister(existingWorker)),
    -16,
    "participants in a normal writer lease cannot exit its frozen cohort",
  );
  assert.equal(errorNumber(channel.publish(reservation, new Uint8Array(9))), -7);
  assert.equal(
    unwrap(channel.observe()).packetLength,
    0,
    "failed packet sizing must not publish partial bytes",
  );

  unwrap(channel.cancelReservation(reservation));
  assert.deepEqual(unwrap(channel.observe()), {
    state: "idle",
    transaction: null,
    generation: 0,
    packetLength: 0,
    cohortSize: 0,
    failure: null,
  });
  assert.equal(errorNumber(channel.publish(reservation, new Uint8Array([1]))), -116);

  const lateWorker = unwrap(channel.register());
  const next = unwrap(channel.reserve(writer));
  assert.ok(next.transaction > reservation.transaction);
  unwrap(channel.publish(next, new Uint8Array([0x61, 0x62, 0x63])));
  assert.equal(unwrap(channel.observe()).cohortSize, 3);
  for (const participant of [writer, existingWorker, lateWorker]) {
    assert.deepEqual(
      unwrap(channel.readPacket(participant, next.transaction)),
      new Uint8Array([0x61, 0x62, 0x63]),
    );
  }

  unwrap(channel.requestAbort(writer, next.transaction));
  for (const participant of [writer, existingWorker, lateWorker])
    unwrap(channel.ack(participant, next.transaction, "abort"));
  assert.deepEqual(unwrap(channel.finish(writer, next.transaction)), {
    generation: 0,
    committed: false,
  });
});

test("finishAndReserve rolls directly into a writing lease after the cohort finishes", () => {
  const channel = new DylinkWorkerChannel(16, 2);
  const writer = unwrap(channel.register());
  const peer = unwrap(channel.register());
  const transaction = unwrap(channel.begin(writer, new Uint8Array([1, 2])));

  for (const participant of [writer, peer])
    unwrap(channel.ack(participant, transaction, "prepare"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "commit");
  for (const participant of [writer, peer]) unwrap(channel.ack(participant, transaction, "commit"));
  assert.equal(unwrap(channel.advance(writer, transaction)), "finalize");
  unwrap(channel.ack(writer, transaction, "finalize"));

  let beforeReleaseCalls = 0;
  assert.equal(
    errorNumber(
      channel.finishAndReserve(writer, transaction, () => {
        beforeReleaseCalls++;
      }),
    ),
    -11,
    "owner release must wait for every cohort acknowledgement",
  );
  assert.equal(beforeReleaseCalls, 0);
  unwrap(channel.ack(peer, transaction, "finalize"));

  const rollover = unwrap(
    channel.finishAndReserve(writer, transaction, () => {
      beforeReleaseCalls++;
    }),
  );
  assert.equal(beforeReleaseCalls, 1);
  assert.deepEqual(rollover.completion, { generation: 1, committed: true });
  assert.ok(rollover.reservation.transaction > transaction);
  assert.equal(rollover.reservation.generation, 1);
  assert.equal(rollover.reservation.cleanup, true);
  assert.deepEqual(unwrap(channel.observe()), {
    state: "writing",
    transaction: rollover.reservation.transaction,
    generation: 1,
    packetLength: 0,
    cohortSize: 1,
    failure: null,
  });
  assert.equal(
    errorNumber(channel.publish(rollover.reservation, new Uint8Array([0x10]))),
    -22,
    "a cleanup lease is not a publishable writer reservation",
  );
  assert.equal(errorNumber(channel.reserve(peer)), -16);
  unwrap(channel.unregister(peer));

  unwrap(channel.cancelReservation(rollover.reservation));
  assert.deepEqual(unwrap(channel.observe()), {
    state: "idle",
    transaction: null,
    generation: 1,
    packetLength: 0,
    cohortSize: 0,
    failure: null,
  });

  const retry = unwrap(channel.reserve(writer));
  assert.ok(retry.transaction > rollover.reservation.transaction);
  assert.equal(retry.generation, 1);
  unwrap(channel.publish(retry, new Uint8Array([0x41, 0x42])));
  assert.equal(unwrap(channel.observe()).state, "prepare");
  assert.deepEqual(
    unwrap(channel.readPacket(writer, retry.transaction)),
    new Uint8Array([0x41, 0x42]),
  );

  unwrap(channel.requestAbort(writer, retry.transaction));
  unwrap(channel.ack(writer, retry.transaction, "abort"));
  const abortRollover = unwrap(channel.finishAndReserve(writer, retry.transaction));
  assert.deepEqual(abortRollover.completion, { generation: 1, committed: false });
  assert.ok(abortRollover.reservation.transaction > retry.transaction);
  assert.equal(abortRollover.reservation.generation, 1);
  unwrap(channel.cancelReservation(abortRollover.reservation));
  assert.equal(unwrap(channel.observe()).generation, 1);
});

test("participant failure is visible, prevents success ack, and remains through Abort", () => {
  const channel = new DylinkWorkerChannel(16, 2);
  const writer = unwrap(channel.register());
  const participant = unwrap(channel.register());
  const transaction = unwrap(channel.begin(writer, new Uint8Array([1, 2, 3])));

  unwrap(channel.reportFailure(participant, transaction, 22));
  unwrap(channel.reportFailure(participant, transaction, 95));
  assert.deepEqual(unwrap(channel.observe()).failure, { participant, errno: 22 });
  unwrap(channel.ack(writer, transaction, "prepare"));
  assert.equal(errorNumber(channel.ack(participant, transaction, "prepare")), -114);
  assert.equal(errorNumber(channel.advance(writer, transaction)), -11);

  unwrap(channel.requestAbort(writer, transaction));
  unwrap(channel.ack(writer, transaction, "abort"));
  unwrap(channel.ack(participant, transaction, "abort"));
  assert.deepEqual(unwrap(channel.observe()).failure, { participant, errno: 22 });
  assert.deepEqual(unwrap(channel.finish(writer, transaction)), {
    generation: 0,
    committed: false,
  });
  assert.equal(unwrap(channel.observe()).failure, null);
});

test("pending Worker admissions block publication until replay completes or admission cancels", () => {
  const channel = new DylinkWorkerChannel(32, 4);
  const writer = unwrap(channel.register());
  const first = unwrap(channel.beginAdmission());
  const second = unwrap(channel.beginAdmission());

  assert.notEqual(first.slot, second.slot);
  assert.equal(
    errorNumber(channel.register()),
    -16,
    "ordinary registration cannot bypass replay admission",
  );
  assert.equal(errorNumber(channel.reserve(writer)), -16);
  assert.equal(errorNumber(channel.begin(writer, new Uint8Array([1]))), -16);
  assert.equal(
    errorNumber(channel.unregister(first)),
    -116,
    "a pending token is not a live participant",
  );

  unwrap(channel.cancelAdmission(first));
  const live = unwrap(channel.completeAdmission(second));
  assert.deepEqual(live, second);
  assert.equal(
    errorNumber(channel.completeAdmission(second)),
    -116,
    "completed admission tokens are stale",
  );

  const transaction = unwrap(channel.begin(writer, new Uint8Array([9, 8])));
  assert.equal(
    errorNumber(channel.completeAdmission(first)),
    -116,
    "cancelled tokens are checked before transaction phase",
  );
  unwrap(channel.requestAbort(writer, transaction));
  unwrap(channel.ack(writer, transaction, "abort"));
  unwrap(channel.ack(live, transaction, "abort"));
  assert.deepEqual(unwrap(channel.finish(writer, transaction)), {
    generation: 0,
    committed: false,
  });

  unwrap(channel.unregister(live));
  assert.deepEqual(unwrap(channel.observe()), {
    state: "idle",
    transaction: null,
    generation: 0,
    packetLength: 0,
    cohortSize: 0,
    failure: null,
  });
});
