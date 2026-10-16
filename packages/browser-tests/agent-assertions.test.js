// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { runtimeAssertions as check } from "./agent-assertions.js";

test("browser runtime assertions preserve exact bigint and byte-view comparisons", () => {
  check.equal(9007199254740993n, 9007199254740993n);
  assert.throws(() => check.equal(9007199254740993n, 9007199254740992n));
  check.notEqual(1n, 1);
  assert.throws(() => check.notEqual(1n, 1n));
  check.deepEqual(Uint8Array.of(9, 1, 2, 8).subarray(1, 3), Uint8Array.of(1, 2));
  assert.throws(() => check.deepEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 3)));
  assert.throws(() => check.deepEqual(Uint8Array.of(1, 2), Uint8Array.of(1)));
});

test("browser runtime status comparisons require every key and value", () => {
  check.deepEqual(
    { success: false, code: 0, signal: "SIGTERM" },
    { signal: "SIGTERM", success: false, code: 0 },
  );
  for (const actual of [
    { code: 0 },
    { success: true, code: 0, signal: null },
    { success: false, code: 0, signal: "SIGKILL" },
  ]) {
    assert.throws(() => check.deepEqual(actual, { success: false, code: 0, signal: "SIGTERM" }));
  }
});

test("browser runtime rejection assertions fail on success and the wrong error", async () => {
  const reason = new Error("expected");
  await check.rejects(Promise.reject(reason), (error) => error === reason);
  await assert.rejects(
    check.rejects(Promise.resolve(), () => true),
    /unexpectedly succeeded/,
  );
  await assert.rejects(
    check.rejects(Promise.reject(reason), () => false),
    (error) => error.cause === reason,
  );
});
