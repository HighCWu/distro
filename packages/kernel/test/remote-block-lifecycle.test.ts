// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";
import { serveDevice, workerDevice } from "../src/virtio/remote.ts";

for (const address of ["i32", "i64"] as const) {
  for (const stopThrows of [false, true]) {
    test(
      `remote ${address} block close waits for disposal, stop throws=${stopThrows}`,
      { timeout: 5000 },
      async () => {
        const entered = Promise.withResolvers<void>();
        const finishRead = Promise.withResolvers<void>();
        const disposing = Promise.withResolvers<void>();
        const finishClose = Promise.withResolvers<void>();
        const events: string[] = [];
        const local = blockDevice({
          capacity: 512,
          async read(_offset, target) {
            events.push("read");
            entered.resolve();
            await finishRead.promise;
            target.fill(0x77);
            events.push("read-finished");
            return target.byteLength;
          },
          stop() {
            events.push("stop");
            finishRead.resolve();
            if (stopThrows) throw new Error("storage stop failure");
          },
          async close() {
            events.push("disposing");
            disposing.resolve();
            await finishClose.promise;
            events.push("disposed");
          },
        });
        const channel = new MessageChannel();
        serveDevice(channel.port1, local);
        const remote = await workerDevice(channel.port2);
        const memory = new WebAssembly.Memory({
          initial: address === "i64" ? 1n : 1,
          maximum: address === "i64" ? 1n : 1,
          shared: true,
          address,
        } as unknown as WebAssembly.MemoryDescriptor);
        const errors: unknown[] = [];
        let interrupts = 0;
        let settled = false;
        void remote.closed.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        const imports = virtio_imports({
          memory,
          memory_address: address,
          devices: [remote],
          trigger_irq() {
            interrupts++;
          },
          on_error(error) {
            errors.push(error);
          },
        });
        const view = new DataView(memory.buffer);
        for (const [index, position, size, flags] of [
          [0, 128, 16, 129],
          [1, 256, 512, 131],
          [2, 1024, 1, 130],
        ] as const) {
          view.setBigUint64(index * 16, BigInt(position), true);
          view.setUint32(index * 16 + 8, size, true);
          view.setUint16(index * 16 + 14, flags, true);
        }
        new Uint8Array(memory.buffer, 256, 512).fill(0x22);
        view.setUint8(1024, 255);
        try {
          imports.enable_vring(0, 0, 4, 0, 1);
          imports.notify(0, 0);
          await entered.promise;
          const closing = close_virtio_device(remote);
          assert.equal(close_virtio_device(remote), closing);
          await disposing.promise;
          assert.equal(settled, false, "remote ack must wait for storage disposal");
          assert.deepEqual(events, ["read", "stop", "read-finished", "disposing"]);
          finishClose.resolve();
          if (stopThrows) await assert.rejects(closing, { message: "storage stop failure" });
          else await closing;
          assert.deepEqual(events, ["read", "stop", "read-finished", "disposing", "disposed"]);
          assert.equal(interrupts, 0);
          assert.deepEqual(new Uint8Array(memory.buffer, 256, 512), new Uint8Array(512).fill(0x22));
          assert.equal(view.getUint8(1024), 255);
          assert.equal(errors.length, stopThrows ? 1 : 0);
        } finally {
          finishRead.resolve();
          finishClose.resolve();
          await close_virtio_device(remote).catch(() => {});
          channel.port1.close();
          channel.port2.close();
        }
      },
    );
  }
}
