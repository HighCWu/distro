// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("block GET_ID explicitly rejects unavailable identity without claiming output bytes", async () => {
  const device = blockDevice({
    capacity: 512,
    read() {
      assert.fail("GET_ID must not read storage");
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const completed = Promise.withResolvers<void>();
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {
      completed.resolve();
    },
    on_error(error) {
      completed.reject(error);
    },
  });
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  function descriptor(index: number, address: number, size: number, flags: number) {
    view.setBigUint64(index * 16, BigInt(address), true);
    view.setUint32(index * 16 + 8, size, true);
    view.setUint16(index * 16 + 14, flags, true);
  }
  try {
    view.setUint32(128, 8, true);
    descriptor(0, 128, 16, 128 | 1);
    descriptor(1, 256, 20, 128 | 1 | 2);
    descriptor(2, 1024, 1, 128 | 2);
    bytes.fill(0xa5, 256, 276);
    view.setUint8(1024, 255);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completed.promise;
    assert.equal(view.getUint8(1024), 2, "UNSUPP, not a fabricated successful ID");
    assert.equal(view.getUint32(8, true), 1, "only status was written");
    assert.deepEqual(bytes.slice(256, 276), new Uint8Array(20).fill(0xa5));
    imports.disable_vring(0, 0);
  } finally {
    await close_virtio_device(device);
  }
});
