// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { collect, expect_ready_message } from "./helpers.ts";

test("readiness accepts split output and releases the stream lock", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of ["listen", "ing\n"]) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  await expect_ready_message(stream, "listening\n");
  assert.equal(stream.locked, false);
});

for (const output of ["", "wrong\n"]) {
  test(`readiness rejects ${output ? "unexpected output" : "early EOF"}`, async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(output));
        controller.close();
      },
    });
    await assert.rejects(expect_ready_message(stream, "listening\n"), /readiness/);
    assert.equal(stream.locked, false);
  });
}

test("readiness times out without leaving the stream locked", async () => {
  const stream = new ReadableStream<Uint8Array>();
  await assert.rejects(expect_ready_message(stream, "listening\n", 10), /timed out/);
  assert.equal(stream.locked, false);
  await stream.cancel();
});

test("collection reads remaining bytes after a readiness reader releases its lock", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("listening\n"));
      controller.enqueue(new TextEncoder().encode("remaining"));
      controller.close();
    },
  });
  await expect_ready_message(stream, "listening\n");
  assert.equal(new TextDecoder().decode(await collect(stream)), "remaining");
  assert.equal(stream.locked, false);
});

test("collection accepts a disturbed stream with no remaining bytes", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("listening\n"));
      controller.close();
    },
  });
  await expect_ready_message(stream, "listening\n");
  assert.deepEqual(await collect(stream), new Uint8Array());
  assert.equal(stream.locked, false);
});

test("collection copies reused Buffer views before the next pull", async () => {
  const backing = Buffer.alloc(4);
  let count = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (count === 3) return controller.close();
        backing.fill(++count);
        controller.enqueue(backing.subarray(1, 3));
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(await collect(stream), Uint8Array.of(1, 1, 2, 2, 3, 3));
  assert.equal(stream.locked, false);
});

test("collection preserves read failures and releases the reader lock", async () => {
  const reason = new Error("output failed");
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(reason);
    },
  });
  await assert.rejects(collect(stream), (error) => error === reason);
  assert.equal(stream.locked, false);
});

test("collection rejects a stream that still has an owner", async () => {
  const stream = new ReadableStream<Uint8Array>();
  const reader = stream.getReader();
  try {
    await assert.rejects(collect(stream), TypeError);
    assert.equal(stream.locked, true);
  } finally {
    reader.releaseLock();
    await stream.cancel();
  }
});
