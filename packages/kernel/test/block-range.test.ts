// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("block capacity rejects values that wrap or lose precision", () => {
  for (const capacity of [-512, 1, 512.5, NaN, Infinity, 2 ** 53]) {
    assert.throws(() => blockDevice({ capacity, read: () => 0 }), RangeError);
  }
});

for (const operation of [0, 1]) {
  test(`block operation ${operation} validates the entire extent before storage access`, async () => {
    for (const [sector, lengths, expected] of [
      [1n, [512], 0],
      [2n, [512], 1],
      [1n, [256, 512], 1],
      [0xffffffffffffffffn, [512], 1],
      [0x20000000000001n, [512], 1],
    ] as const) {
      const accesses: number[] = [];
      const storage = {
        capacity: 1024,
        read(offset: number, target: Uint8Array) {
          accesses.push(offset);
          return target.byteLength;
        },
        write(offset: number, data: Uint8Array) {
          accesses.push(offset);
          return data.byteLength;
        },
      };
      const device = blockDevice(storage);
      // Changing the caller object must not expand the capacity advertised at boot.
      storage.capacity = 4096;
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
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
      const desc = (index: number, address: number, length: number, flags: number) => {
        view.setBigUint64(index * 16, BigInt(address), true);
        view.setUint32(index * 16 + 8, length, true);
        view.setUint16(index * 16 + 14, flags, true);
      };
      view.setUint32(128, operation, true);
      view.setBigUint64(136, sector, true);
      desc(0, 128, 16, 128 | 1);
      lengths.forEach((length, i) =>
        desc(i + 1, 256 + i * 512, length, 128 | 1 | (operation === 0 ? 2 : 0)),
      );
      desc(lengths.length + 1, 2048, 1, 128 | 2);
      view.setUint8(2048, 255);
      imports.enable_vring(0, 0, 4, 0, 1);
      imports.notify(0, 0);
      try {
        await done.promise;
        assert.equal(view.getUint8(2048), expected);
        assert.equal(view.getUint32(8, true), operation === 0 && expected === 0 ? 513 : 1);
        assert.deepEqual(accesses, expected === 0 ? [512] : []);
      } finally {
        await close_virtio_device(device);
      }
    }
  });
}
