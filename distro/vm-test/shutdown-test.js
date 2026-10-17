// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { closeTestResources } from "./shutdown.js";

test("runner keeps disks open until machine shutdown actually settles", async () => {
  const gate = Promise.withResolvers();
  const events = [];
  const closing = closeTestResources(
    {
      close() {
        events.push("close");
      },
      closed: gate.promise,
    },
    [10, 11],
    (fd) => events.push(fd),
  );
  assert.deepEqual(events, ["close"]);
  gate.resolve();
  await closing;
  assert.deepEqual(events, ["close", 10, 11]);
});

test("shutdown failure still releases every disk and preserves the first failure", async () => {
  const failure = new Error("device flush failed");
  const events = [];
  await assert.rejects(
    closeTestResources({ close() {}, closed: Promise.reject(failure) }, [10, 11], (fd) => {
      events.push(fd);
      throw new Error("disk close failed");
    }),
    (error) => error === failure,
  );
  assert.deepEqual(events, [10, 11]);
});

test("synchronous machine close failure still waits before releasing disks", async () => {
  const failure = new Error("close failed synchronously");
  const gate = Promise.withResolvers();
  const events = [];
  const closing = closeTestResources(
    {
      close() {
        throw failure;
      },
      closed: gate.promise,
    },
    [10],
    (fd) => events.push(fd),
  );
  assert.deepEqual(events, []);
  gate.resolve();
  await assert.rejects(closing, (error) => error === failure);
  assert.deepEqual(events, [10]);
});

test("disk cleanup without a machine tries all descriptors, even on non-Error failures", async () => {
  const events = [];
  const failure = undefined;
  try {
    await closeTestResources(null, [10, 11], (fd) => {
      events.push(fd);
      throw failure;
    });
    assert.fail("cleanup should reject");
  } catch (error) {
    assert.equal(error, failure);
  }
  assert.deepEqual(events, [10, 11]);
});
