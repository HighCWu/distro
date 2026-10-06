// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { FileMmapStaging } from "../src/file-mmap-staging.ts";

function fixture() {
  const buffer = new Uint8Array(8);
  let released = 0;
  const task = new FileMmapStaging(buffer, (owned) => {
    assert.equal(owned, buffer);
    released++;
  });
  return { task, buffer, releases: () => released };
}

test("reading is not committable; successful copy releases staging exactly once", () => {
  const { task, buffer, releases } = fixture();
  assert.equal(task.begin_commit(), null);
  buffer.fill(0x5a);
  assert.equal(task.complete_read(), true);
  assert.equal(releases(), 0);
  const lease = task.begin_commit();
  assert.ok(lease);
  const candidate = lease.buffer.slice();
  assert.equal(lease.finish(true), true);
  assert.equal(task.state, "committed");
  assert.equal(releases(), 1);
  assert.deepEqual(candidate, new Uint8Array(8).fill(0x5a));
  assert.equal(lease.finish(true), false);
  assert.equal(task.complete_read(), false);
  assert.equal(task.abort(), false);
  assert.equal(task.begin_commit(), null);
  assert.equal(releases(), 1);
});

test("cancelled reading retains memory until the producer stops writing", () => {
  const { task, buffer, releases } = fixture();
  assert.equal(task.abort(), true);
  assert.equal(releases(), 0);
  buffer.fill(0x6d); // Producer may still write after consumer cancellation.
  assert.equal(task.begin_commit(), null);
  assert.equal(task.complete_read(), true);
  assert.equal(releases(), 1);
  assert.equal(task.complete_read(), false);
  assert.equal(task.abort(5), false);
  assert.equal(task.error, 4);
  assert.equal(releases(), 1);
});

test("read failure terminates and releases rather than hanging forever", () => {
  const { task, releases } = fixture();
  assert.equal(task.complete_read(5), true);
  assert.equal(task.state, "aborted");
  assert.equal(task.error, 5);
  assert.equal(task.begin_commit(), null);
  assert.equal(releases(), 1);
});

test("cancellation after readiness releases without ever granting a lease", () => {
  const { task, releases } = fixture();
  task.complete_read();
  task.abort(12);
  assert.equal(task.error, 12);
  assert.equal(task.begin_commit(), null);
  assert.equal(releases(), 1);
});

test("cancel during copy retains staging until the lease ends and denies commit", () => {
  const { task, releases } = fixture();
  task.complete_read();
  const lease = task.begin_commit();
  assert.ok(lease);
  assert.equal(task.begin_commit(), null);
  task.abort();
  assert.equal(releases(), 0);
  assert.equal(lease.buffer.length, 8);
  assert.equal(lease.finish(true), false); // Caller must discard its candidate.
  assert.equal(task.state, "aborted");
  assert.equal(releases(), 1);
});

test("copy failure rolls back and cannot be retried as successful publication", () => {
  const { task, releases } = fixture();
  task.complete_read();
  const lease = task.begin_commit();
  assert.ok(lease);
  try {
    throw new Error("injected copy failure");
  } catch {
    assert.equal(lease.finish(false), false);
  }
  assert.equal(task.state, "aborted");
  assert.equal(task.error, 5);
  assert.equal(lease.finish(true), false);
  assert.equal(releases(), 1);
});

test("old request completion cannot affect a new record for a reused identity", () => {
  const old = fixture();
  old.task.abort();
  const fresh = fixture();
  old.task.complete_read();
  assert.equal(old.releases(), 1);
  assert.equal(fresh.task.state, "reading");
  assert.equal(fresh.releases(), 0);
  fresh.task.complete_read(5);
  assert.equal(fresh.releases(), 1);
});

test("invalid error input cannot settle or release an active request", () => {
  const { task, releases } = fixture();
  for (const errno of [-1, 0.5, 4096, NaN]) {
    assert.throws(() => task.abort(errno), RangeError);
    assert.throws(() => task.complete_read(errno), RangeError);
  }
  assert.equal(task.state, "reading");
  assert.equal(releases(), 0);
  task.complete_read(5);
});
