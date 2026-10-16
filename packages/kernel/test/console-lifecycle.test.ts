// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { consoleDevice } from "../src/virtio/console.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("empty input does not block and partial delivery resumes source pulls", async () => {
  const chunks = [new Uint8Array(), new Uint8Array([1, 2, 3, 4, 5]), new Uint8Array([6, 7])];
  let pulls = 0;
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[pulls++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const device = consoleDevice(input, null);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  const view = new DataView(memory.buffer);
  for (let i = 0; i < 4; i++) {
    view.setBigUint64(i * 16, BigInt(256 + i * 8), true);
    view.setUint32(i * 16 + 8, 2, true);
    view.setUint16(i * 16 + 12, i, true);
    view.setUint16(i * 16 + 14, (1 << 7) | (1 << 1), true);
  }
  imports.enable_vring(0, 0, 4, 0, 1);
  imports.notify(0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pulls, 2, "skip empty chunk, then stop until input is consumed");
  // First output notification opens the console input handoff.
  view.setBigUint64(128, 512n, true);
  view.setUint32(136, 1, true);
  view.setUint16(142, 1 << 7, true);
  imports.enable_vring(0, 1, 1, 128, 2);
  imports.notify(0, 1);
  await new Promise((resolve) => setImmediate(resolve));
  const bytes = new Uint8Array(memory.buffer);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => [...bytes.slice(256 + i * 8, 258 + i * 8)]),
    [
      [1, 2],
      [3, 4],
      [5, 0],
      [6, 7],
    ],
  );
  assert.equal(pulls, 4, "source continues through the second chunk and EOF");
  await close_virtio_device(device);
});

test("console stops pulling input while Linux has no receive buffers", async () => {
  let pulls = 0;
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([42]));
        // Bound the fixture so a regression fails instead of starving timers.
        if (pulls === 16) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const device = consoleDevice(input, null);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      throw error;
    },
  });
  // An enabled receive queue without an available descriptor starts input
  // handling but cannot consume any of the source bytes yet.
  imports.enable_vring(0, 0, 1, 0, 1);
  imports.notify(0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pulls, 1);
  await close_virtio_device(device);
  assert.equal(cancelled, true);
  assert.equal(input.locked, false);
});

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
