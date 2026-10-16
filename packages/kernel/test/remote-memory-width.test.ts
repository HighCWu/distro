// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";
import { serveDevice, workerDevice } from "../src/virtio/remote.ts";

for (const address of ["i32", "i64"] as const) {
  test(
    `remote block binding and I/O preserve ${address} shared-memory width`,
    { timeout: 5000 },
    async () => {
      const memory = new WebAssembly.Memory({
        initial: address === "i64" ? 1n : 1,
        maximum: address === "i64" ? 2n : 2,
        shared: true,
        address,
      } as unknown as WebAssembly.MemoryDescriptor);
      const bytes = new Uint8Array(512).fill(0x37);
      let flushed = 0;
      let closed = 0;
      const local = blockDevice({
        capacity: 512,
        read(offset, target) {
          target.set(bytes.subarray(offset, offset + target.byteLength));
          return target.byteLength;
        },
        write(offset, data) {
          bytes.set(data, offset);
          return data.byteLength;
        },
        flush() {
          flushed++;
        },
        close() {
          closed++;
        },
      });
      const channel = new MessageChannel();
      serveDevice(channel.port1, local);
      const remote = await workerDevice(channel.port2);
      let irq = Promise.withResolvers<void>();
      const imports = virtio_imports({
        memory,
        memory_address: address,
        devices: [remote],
        trigger_irq() {
          irq.resolve();
        },
        on_error(error) {
          irq.reject(error);
        },
      });
      const view = new DataView(memory.buffer);
      const descriptor = (index: number, position: number, size: number, flags: number) => {
        view.setBigUint64(index * 16, BigInt(position), true);
        view.setUint32(index * 16 + 8, size, true);
        view.setUint16(index * 16 + 14, flags, true);
      };
      try {
        for (const operation of [0, 1, 4]) {
          irq = Promise.withResolvers<void>();
          view.setUint32(128, operation, true);
          descriptor(0, 128, 16, 128 | 1);
          if (operation === 4) descriptor(1, 1024, 1, 128 | 2);
          else {
            descriptor(1, 256, 512, 128 | 1 | (operation === 0 ? 2 : 0));
            descriptor(2, 1024, 1, 128 | 2);
          }
          if (operation === 1) new Uint8Array(memory.buffer, 256, 512).fill(0x65);
          view.setUint8(1024, 255);
          imports.enable_vring(0, 0, 4, 0, 1);
          imports.notify(0, 0);
          await irq.promise;
          assert.equal(view.getUint8(1024), 0);
          if (operation === 0) assert.deepEqual(new Uint8Array(memory.buffer, 256, 512), bytes);
          if (operation === 1) assert.deepEqual(bytes, new Uint8Array(512).fill(0x65));
          imports.disable_vring(0, 0);
        }
        assert.equal(flushed, 1);
      } finally {
        await close_virtio_device(remote);
        assert.equal(closed, 1);
        channel.port1.close();
        channel.port2.close();
      }
    },
  );
}
