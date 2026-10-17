// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";
import { workerDevice } from "../src/virtio/remote.ts";

class Endpoint extends EventEmitter {
  failure: unknown = new Error("close transport failed");
  messages: unknown[] = [];
  throwOnClose = true;
  start() {
    this.emit("message", {
      type: "ready",
      device_id: 2,
      features: 0n,
      config: new Uint8Array(8),
      queues: 1,
    });
  }
  postMessage(message: unknown) {
    this.messages.push(message);
    if ((message as { type: string }).type === "close") {
      if (this.throwOnClose) throw this.failure;
      queueMicrotask(() => this.emit("message", { type: "closed" }));
    }
  }
}

for (const attached of [false, true]) {
  for (const nonError of [false, true]) {
    test(`remote close send failure settles shared promise, attached=${attached}, nonError=${nonError}`, async () => {
      const endpoint = new Endpoint();
      if (nonError) endpoint.failure = "closed transport";
      const remote = await workerDevice(endpoint);
      const errors: unknown[] = [];
      if (attached)
        virtio_imports({
          memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
          devices: [remote],
          trigger_irq() {
            assert.fail("unexpected interrupt");
          },
          on_error(error) {
            errors.push(error);
          },
        });
      let closing: Promise<void> | undefined;
      assert.doesNotThrow(() => {
        closing = close_virtio_device(remote);
      });
      assert.equal(closing, remote.closed);
      await assert.rejects(closing!, (error) =>
        nonError
          ? error instanceof Error && error.message === endpoint.failure
          : error === endpoint.failure,
      );
      assert.equal(close_virtio_device(remote), closing);
      assert.equal(
        endpoint.messages.filter((message) => (message as { type: string }).type === "close")
          .length,
        1,
      );
      assert.equal(errors.length, attached ? 1 : 0);
      for (const event of ["message", "messageerror", "error"])
        assert.equal(endpoint.listenerCount(event), 0, event);
    });
  }
}

test("remote close preserves an earlier terminal endpoint failure without sending again", async () => {
  const endpoint = new Endpoint();
  const remote = await workerDevice(endpoint);
  const error = new Error("endpoint already failed");
  endpoint.emit("error", error);
  await assert.rejects(remote.closed, (value) => value === error);
  let closing: Promise<void> | undefined;
  assert.doesNotThrow(() => {
    closing = close_virtio_device(remote);
  });
  await assert.rejects(closing!, (value) => value === error);
  assert.deepEqual(endpoint.messages, []);
});

test("a remotely reported error does not prevent requesting backend disposal", async () => {
  const endpoint = new Endpoint();
  endpoint.throwOnClose = false;
  const remote = await workerDevice(endpoint);
  endpoint.emit("message", { type: "error", error: { name: "Error", message: "backend failed" } });
  await assert.rejects(remote.closed, { message: "backend failed" });
  await assert.rejects(close_virtio_device(remote), { message: "backend failed" });
  assert.deepEqual(endpoint.messages, [{ type: "close" }]);
  for (const event of ["message", "messageerror", "error"])
    assert.equal(endpoint.listenerCount(event), 0, event);
});
