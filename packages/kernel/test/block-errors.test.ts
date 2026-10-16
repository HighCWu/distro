// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const operation of [0, 1, 4]) {
  for (const asynchronous of [false, true]) {
    test(`block operation ${operation} reports ${asynchronous ? "rejection" : "throw"} as IOERR and recovers`, async () => {
      let fail = true;
      const perform = (size: number): number | Promise<number> => {
        if (!fail) return size;
        const error = new Error("storage unavailable");
        if (asynchronous) return Promise.reject(error);
        throw error;
      };
      const device = blockDevice({
        capacity: 512,
        read(_offset, target) {
          return perform(target.byteLength);
        },
        write(_offset, data) {
          return perform(data.byteLength);
        },
        flush() {
          const result = perform(0);
          if (result instanceof Promise) return result.then(() => {});
        },
      });
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      let interrupt = Promise.withResolvers<void>();
      const imports = virtio_imports({
        memory,
        devices: [device],
        trigger_irq() {
          interrupt.resolve();
        },
        on_error(error) {
          interrupt.reject(error);
        },
      });
      const view = new DataView(memory.buffer);
      const descriptor = (index: number, address: number, size: number, flags: number) => {
        view.setBigUint64(index * 16, BigInt(address), true);
        view.setUint32(index * 16 + 8, size, true);
        view.setUint16(index * 16 + 14, flags, true);
      };
      try {
        for (const expected of [1, 0]) {
          interrupt = Promise.withResolvers<void>();
          view.setUint32(128, operation, true);
          descriptor(0, 128, 16, 128 | 1);
          if (operation === 4) descriptor(1, 1024, 1, 128 | 2);
          else {
            descriptor(1, 256, 512, 128 | 1 | (operation === 0 ? 2 : 0));
            descriptor(2, 1024, 1, 128 | 2);
          }
          view.setUint8(1024, 255);
          imports.enable_vring(0, 0, 4, 0, 1);
          imports.notify(0, 0);
          await interrupt.promise;
          assert.equal(view.getUint8(1024), expected);
          imports.disable_vring(0, 0);
          fail = false;
        }
      } finally {
        await close_virtio_device(device);
      }
    });
  }
}
