// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import {
  settle_user_copy,
  reject_user_copy,
  user_copy_failed,
  USER_COPY_COMPLETE,
  USER_COPY_NO_MEMORY,
  USER_COPY_TRY_AGAIN,
  wait_user_copy,
} from "../src/user-copy.ts";

const copy_status = () => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

test("late initialization errors preserve timeout and allocation failures", () => {
  for (const errno of [USER_COPY_TRY_AGAIN, USER_COPY_NO_MEMORY]) {
    const status = copy_status();
    assert.equal(user_copy_failed(status), false);
    assert.equal(settle_user_copy(status, errno), true);
    assert.equal(reject_user_copy(status), true);
    assert.equal(reject_user_copy(status), true);
    assert.equal(user_copy_failed(status), true);
    assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), false);
    assert.equal(wait_user_copy(status, 0), errno);
  }
});

test("initialization failure only absorbs unpublished copy errors", () => {
  const pending = copy_status();
  assert.equal(reject_user_copy(pending), true);
  assert.equal(wait_user_copy(pending), USER_COPY_TRY_AGAIN);
  const complete = copy_status();
  assert.equal(settle_user_copy(complete, USER_COPY_COMPLETE), true);
  assert.equal(reject_user_copy(complete), false, "published child errors remain machine failures");
  assert.equal(user_copy_failed(complete), false);
  assert.equal(wait_user_copy(complete), USER_COPY_COMPLETE);
  assert.equal(reject_user_copy(null), false, "ordinary worker errors are not copy failures");
  assert.equal(user_copy_failed(null), false);
});

test(
  "a real late worker cannot publish after the parent times out",
  { timeout: 5000 },
  async (context) => {
    const module = new URL("../src/user-copy.ts", import.meta.url).href;
    const worker = new Worker(
      `
    const { parentPort } = require('node:worker_threads');
    parentPort.once('message', async (status) => {
      const { user_copy_failed, reject_user_copy, settle_user_copy, USER_COPY_COMPLETE } =
        await import(${JSON.stringify(module)});
      parentPort.once('message', () => {
        parentPort.postMessage({
          failed: user_copy_failed(status),
          rejected: reject_user_copy(status),
          published: settle_user_copy(status, USER_COPY_COMPLETE),
          result: Atomics.load(status, 0),
        });
        parentPort.close();
      });
      parentPort.postMessage('ready');
    });
  `,
      { eval: true },
    );
    context.after(() => worker.terminate());
    const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
    const message = () =>
      new Promise<unknown>((resolve, reject) => {
        const onError = (error: Error) => {
          worker.off("message", onMessage);
          reject(error);
        };
        const onMessage = (value: unknown) => {
          worker.off("error", onError);
          resolve(value);
        };
        worker.once("error", onError);
        worker.once("message", onMessage);
      });
    const status = copy_status();
    const ready = message();
    worker.postMessage(status);
    assert.equal(await ready, "ready");
    assert.equal(wait_user_copy(status, 0), USER_COPY_TRY_AGAIN);
    const result = message();
    worker.postMessage("continue");
    assert.deepEqual(await result, {
      failed: true,
      rejected: true,
      published: false,
      result: USER_COPY_TRY_AGAIN,
    });
    assert.equal(await exited, 0);
  },
);

test("user-memory copy deadline uses monotonic time across wakeups", (context) => {
  const ticks = [100, 100, 101, 105];
  context.mock.method(performance, "now", () => {
    assert.ok(ticks.length > 0, "wait must stop at its original deadline");
    return ticks.shift()!;
  });
  context.mock.method(Date, "now", () => {
    assert.fail("wall-clock changes must not affect copy timeout");
  });
  const waits: number[] = [];
  context.mock.method(
    Atomics,
    "wait",
    (_array: unknown, _index: number, _value: number, timeout: number) => {
      waits.push(timeout);
      return "ok" as const;
    },
  );
  const status = copy_status();
  assert.equal(wait_user_copy(status, 5), USER_COPY_TRY_AGAIN);
  assert.deepEqual(waits, [5, 4]);
  assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), false);
});

test("user-memory copy publishes only its first terminal result", () => {
  const status = copy_status();

  assert.equal(settle_user_copy(status, USER_COPY_NO_MEMORY), true);
  assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), false);
  assert.equal(Atomics.load(status, 0), USER_COPY_NO_MEMORY);
});

test("user-memory copy wait observes an already completed snapshot", () => {
  const status = copy_status();

  assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), true);
  assert.equal(wait_user_copy(status), USER_COPY_COMPLETE);
});

test("user-memory copy timeout cancels a late child", () => {
  const status = copy_status();

  assert.equal(wait_user_copy(status, 0), USER_COPY_TRY_AGAIN);
  assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), false);
  assert.equal(Atomics.load(status, 0), USER_COPY_TRY_AGAIN);
});
