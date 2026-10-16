// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { consoleDevice } from "../src/virtio/console.ts";
import { close_virtio_device } from "../src/virtio/core.ts";

test("failed console construction releases input without cancelling it", async () => {
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([42]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const output = new WritableStream<Uint8Array>();
  const owner = output.getWriter();
  assert.throws(() => consoleDevice(input, output), TypeError);
  assert.equal(input.locked, false);
  assert.equal(cancelled, false);
  assert.equal(output.locked, true);
  const reader = input.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([42]));
  await reader.cancel();
  reader.releaseLock();
  owner.releaseLock();
});

test("console closure releases both locks even when cancellation rejects", async () => {
  for (const rejectCancellation of [false, true]) {
    const failure = new Error("input cancellation failed");
    const input = new ReadableStream<Uint8Array>({
      cancel() {
        if (rejectCancellation) throw failure;
      },
    });
    const output = new WritableStream<Uint8Array>();
    const device = consoleDevice(input, output);
    assert.equal(input.locked, true);
    assert.equal(output.locked, true);
    const closing = close_virtio_device(device);
    if (rejectCancellation) await assert.rejects(closing, (error) => error === failure);
    else await closing;
    assert.equal(input.locked, false);
    assert.equal(output.locked, false);
    assert.equal(close_virtio_device(device), closing);
  }
});
