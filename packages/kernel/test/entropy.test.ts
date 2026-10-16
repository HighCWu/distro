// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { entropyDevice } from "../src/virtio/entropy.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const size of [0, 65536, 65537, 131073]) {
  test(`entropy fills ${size} bytes within the Web Crypto quota`, async (t) => {
    const calls: number[] = [];
    t.mock.method(crypto, "getRandomValues", (array: Uint8Array) => {
      assert.ok(array.byteLength <= 65536);
      assert.ok(array.buffer instanceof ArrayBuffer);
      calls.push(array.byteLength);
      array.fill(calls.length);
      return array;
    });
    const device = entropyDevice();
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 4, shared: true });
    const done = Promise.withResolvers<void>();
    const imports = virtio_imports({
      memory,
      devices: [device],
      trigger_irq() {
        done.resolve();
      },
      on_error(error) {
        done.reject(error);
      },
    });
    const view = new DataView(memory.buffer);
    view.setBigUint64(0, 256n, true);
    view.setUint32(8, size, true);
    view.setUint16(14, 128 | 2, true);
    new Uint8Array(memory.buffer, 256, size + 1).fill(255);
    try {
      imports.enable_vring(0, 0, 4, 0, 1);
      imports.notify(0, 0);
      await done.promise;
      assert.equal(view.getUint32(8, true), size);
      assert.equal(
        calls.reduce((sum, length) => sum + length, 0),
        size,
      );
      const output = new Uint8Array(memory.buffer, 256, size);
      for (let i = 0; i < size; i++) assert.equal(output[i], Math.floor(i / 65536) + 1);
      assert.equal(view.getUint8(256 + size), 255, "does not overwrite the next byte");
    } finally {
      await close_virtio_device(device);
    }
  });
}
