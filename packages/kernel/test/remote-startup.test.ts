// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device } from "../src/virtio/core.ts";
import { serveDevice, workerDevice } from "../src/virtio/remote.ts";

const ready = {
  type: "ready",
  device_id: 2,
  features: 0n,
  config: new Uint8Array(8),
  queues: 1,
};
class Endpoint extends EventEmitter {
  starts = 0;
  sent: unknown[] = [];
  onStart = () => {};
  start() {
    this.starts++;
    this.onStart();
  }
  postMessage(value: unknown) {
    this.sent.push(value);
    if ((value as { type: string }).type === "close")
      queueMicrotask(() => this.emit("message", { type: "closed" }));
  }
}
function noStartupListeners(endpoint: Endpoint, signal: AbortSignal) {
  for (const name of ["message", "messageerror", "error"])
    assert.equal(endpoint.listenerCount(name), 0, name);
  assert.equal(getEventListeners(signal, "abort").length, 0);
}

test("pre-aborted worker startup does not start or acquire the endpoint", async () => {
  const endpoint = new Endpoint();
  const controller = new AbortController();
  const reason = { cancelled: true };
  controller.abort(reason);
  await assert.rejects(workerDevice(endpoint, { signal: controller.signal }), (e) => e === reason);
  assert.equal(endpoint.starts, 0);
  assert.deepEqual(endpoint.sent, []);
  noStartupListeners(endpoint, controller.signal);
});

test("pending startup abort preserves its reason and ignores late readiness", async () => {
  const endpoint = new Endpoint();
  const controller = new AbortController();
  const pending = workerDevice(endpoint, { signal: controller.signal });
  const reason = new Error("cancel startup");
  controller.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  endpoint.emit("message", ready);
  assert.deepEqual(endpoint.sent, []);
  noStartupListeners(endpoint, controller.signal);
});

test("ready wins before later abort and endpoint startup can report readiness synchronously", async () => {
  const endpoint = new Endpoint();
  endpoint.onStart = () => {
    endpoint.emit("message", ready);
  };
  const controller = new AbortController();
  const device = await workerDevice(endpoint, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort(new Error("too late to cancel startup"));
  assert.deepEqual(endpoint.sent, []);
  await close_virtio_device(device);
  assert.deepEqual(endpoint.sent, [{ type: "close" }]);
  noStartupListeners(endpoint, controller.signal);
});

test("endpoint failure releases abort and startup listeners", async () => {
  for (const kind of ["error", "messageerror"] as const) {
    const endpoint = new Endpoint();
    const controller = new AbortController();
    const pending = workerDevice(endpoint, { signal: controller.signal });
    const reason = new Error(kind);
    endpoint.emit(kind, reason);
    await assert.rejects(pending, (e) => e === reason);
    noStartupListeners(endpoint, controller.signal);
  }
});

test("synchronous start failure rejects the promise without leaving listeners", async () => {
  const endpoint = new Endpoint();
  const controller = new AbortController();
  const reason = new Error("start failed");
  endpoint.onStart = () => {
    throw reason;
  };
  await assert.rejects(workerDevice(endpoint, { signal: controller.signal }), (e) => e === reason);
  noStartupListeners(endpoint, controller.signal);
});

test(
  "a real message port remains reusable after cancelled device startup",
  { timeout: 5000 },
  async () => {
    const channel = new MessageChannel();
    const controller = new AbortController();
    let closes = 0;
    try {
      const cancelled = workerDevice(channel.port2, { signal: controller.signal });
      controller.abort();
      await assert.rejects(cancelled, { name: "AbortError" });
      const pending = workerDevice(channel.port2);
      serveDevice(
        channel.port1,
        blockDevice({
          capacity: 512,
          read: (_offset, target) => target.byteLength,
          close() {
            closes++;
          },
        }),
      );
      const device = await pending;
      await close_virtio_device(device);
      assert.equal(closes, 1);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  },
);
