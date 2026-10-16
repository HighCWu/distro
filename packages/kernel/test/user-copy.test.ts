// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  settle_user_copy,
  USER_COPY_COMPLETE,
  USER_COPY_NO_MEMORY,
  USER_COPY_TRY_AGAIN,
  wait_user_copy,
} from "../src/user-copy.ts";

const copy_status = () => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

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
