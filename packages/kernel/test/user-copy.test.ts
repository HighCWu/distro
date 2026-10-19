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

test("cooperative copy wait yields between slices without extending its original deadline", (context) => {
  let now = 0,
    yields = 0;
  const waits: number[] = [];
  context.mock.method(performance, "now", () => now);
  context.mock.method(
    Atomics,
    "wait",
    (_array: unknown, _index: number, _value: number, timeout: number) => {
      waits.push(timeout);
      now += timeout;
      return "timed-out" as const;
    },
  );
  const status = copy_status();
  assert.equal(
    wait_user_copy(status, 25, () => {
      yields++;
      now += 2;
    }),
    USER_COPY_TRY_AGAIN,
  );
  assert.deepEqual(waits, [10, 10, 1]);
  assert.equal(yields, 2);
  assert.equal(now, 25);
  assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), false);
});

test("cooperative copy observes completion or failure after yielding, without another wait", (context) => {
  for (const result of [USER_COPY_COMPLETE, USER_COPY_NO_MEMORY, USER_COPY_TRY_AGAIN]) {
    const status = copy_status();
    let now = 0,
      waits = 0,
      yields = 0;
    context.mock.method(performance, "now", () => now);
    context.mock.method(Atomics, "wait", () => {
      waits++;
      now++;
      return "ok" as const;
    });
    assert.equal(
      wait_user_copy(status, 30_000, () => {
        yields++;
        settle_user_copy(status, result);
      }),
      result,
    );
    assert.equal(waits, 1);
    assert.equal(yields, 1);
  }
});

test("time spent in the kernel scheduler counts against the same copy deadline", (context) => {
  let now = 0,
    waits = 0,
    yields = 0;
  context.mock.method(performance, "now", () => now);
  context.mock.method(Atomics, "wait", () => {
    waits++;
    now += 10;
    return "timed-out" as const;
  });
  const status = copy_status();
  assert.equal(
    wait_user_copy(status, 25, () => {
      yields++;
      now += 30;
    }),
    USER_COPY_TRY_AGAIN,
  );
  assert.equal(waits, 1);
  assert.equal(yields, 1);
  assert.equal(settle_user_copy(status, USER_COPY_COMPLETE), false);
});

test("cooperative copy skips scheduling for terminal results, expired deadlines and final publication", (context) => {
  for (const result of [USER_COPY_COMPLETE, USER_COPY_NO_MEMORY, USER_COPY_TRY_AGAIN]) {
    const status = copy_status();
    settle_user_copy(status, result);
    assert.equal(
      wait_user_copy(status, 0, () => assert.fail("terminal result yielded")),
      result,
    );
  }
  assert.equal(
    wait_user_copy(copy_status(), 0, () => assert.fail("expired request yielded")),
    USER_COPY_TRY_AGAIN,
  );
  const status = copy_status();
  context.mock.method(Atomics, "wait", () => {
    settle_user_copy(status, USER_COPY_COMPLETE);
    return "ok" as const;
  });
  assert.equal(
    wait_user_copy(status, 30_000, () => assert.fail("published copy yielded")),
    USER_COPY_COMPLETE,
  );
});

test("a cooperative scheduling trap is not silently converted to a successful copy or errno", (context) => {
  context.mock.method(Atomics, "wait", () => "ok" as const);
  const status = copy_status();
  const failure = new Error("scheduler trap");
  assert.throws(
    () =>
      wait_user_copy(status, 30_000, () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(Atomics.load(status, 0), 0);
});

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
