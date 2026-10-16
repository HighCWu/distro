// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { cache_successful_load } from "../src/resource-cache.ts";

test("concurrent boots share loading and successful resources", async () => {
  let calls = 0;
  const resource = {};
  const load = cache_successful_load(async () => {
    calls++;
    return resource;
  });
  const first = load();
  assert.equal(load(), first);
  assert.equal(await first, resource);
  assert.equal(await load(), resource);
  assert.equal(calls, 1);
});

test("failed concurrent boots receive the original error and a later boot retries", async () => {
  let calls = 0;
  const failure = new Error("temporary fetch failure");
  const resource = {};
  const load = cache_successful_load(async () => {
    if (++calls === 1) throw failure;
    return resource;
  });
  const first = load();
  const concurrent = load();
  assert.equal(first, concurrent);
  const outcomes = await Promise.allSettled([first, concurrent]);
  for (const outcome of outcomes) {
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.equal(outcome.reason, failure);
  }
  const retry = load();
  assert.notEqual(retry, first);
  assert.equal(load(), retry);
  assert.equal(await retry, resource);
  assert.equal(calls, 2);
});

test("synchronous loader failure is also retryable and does not escape the promise API", async () => {
  let calls = 0;
  const load = cache_successful_load(() => {
    calls++;
    throw new Error("invalid resource");
  });
  await assert.rejects(load(), /invalid resource/);
  await assert.rejects(load(), /invalid resource/);
  assert.equal(calls, 2);
});
