// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const operation of [0, 1, 4]) {
  for (const stopMode of ["none", "normal", "cancel", "throws"]) {
    for (const ioRejects of [false, true]) {
      test(`block ${operation} drains before closing, stop=${stopMode}, I/O rejects=${ioRejects}`, async () => {
        const events: string[] = [];
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const stopError = new Error("storage stop failed");
        const perform = async (size: number) => {
          events.push("entered");
          entered.resolve();
          try {
            await finish.promise;
          } finally {
            events.push("settled");
          }
          if (ioRejects) throw new Error("in-flight I/O cancelled");
          return size;
        };
        // A variable also permits this regression to execute against the old
        // interface, where stop was silently unused by the block driver.
        const storage = {
          capacity: 1024,
          read(_offset: number, target: Uint8Array) {
            return perform(target.byteLength);
          },
          write(_offset: number, data: Uint8Array) {
            return perform(data.byteLength);
          },
          async flush() {
            await perform(0);
          },
          stop:
            stopMode === "none"
              ? undefined
              : () => {
                  events.push("stop");
                  if (stopMode === "cancel") finish.reject(new Error("cancelled by storage stop"));
                  if (stopMode === "throws") throw stopError;
                },
          close() {
            events.push("close");
          },
        };
        const device = blockDevice(storage);
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
        let interrupts = 0;
        const errors: unknown[] = [];
        const imports = virtio_imports({
          memory,
          devices: [device],
          trigger_irq() {
            interrupts++;
          },
          on_error(error) {
            errors.push(error);
          },
        });
        const view = new DataView(memory.buffer);
        let descriptorIndex = 0;
        // Queue two complete requests before the first async operation starts.
        // Neither the second chain nor a second data descriptor may start I/O
        // after stop, even when the first operation eventually succeeds.
        for (let request = 0; request < 2; request++) {
          const header = 256 + request * 32;
          view.setUint32(header, operation, true);
          const descriptor = (address: number, length: number, flags: number) => {
            const base = descriptorIndex++ * 16;
            view.setBigUint64(base, BigInt(address), true);
            view.setUint32(base + 8, length, true);
            view.setUint16(base + 14, 128 | flags, true);
          };
          descriptor(header, 16, 1);
          if (operation !== 4) {
            descriptor(512, 512, 1 | (operation === 0 ? 2 : 0));
            descriptor(1024, 512, 1 | (operation === 0 ? 2 : 0));
          }
          descriptor(2048 + request, 1, 2);
          view.setUint8(2048 + request, 255);
        }
        let closing: Promise<void> | undefined;
        try {
          imports.enable_vring(0, 0, 16, 0, 1);
          imports.notify(0, 0);
          await entered.promise;
          closing = close_virtio_device(device);
          void closing.catch(() => {});
          const expected = stopMode === "none" ? ["entered"] : ["entered", "stop"];
          assert.deepEqual(events, expected);
          assert.equal(close_virtio_device(device), closing, "close is idempotent");
          finish.resolve();
          if (stopMode === "throws") await assert.rejects(closing, (error) => error === stopError);
          else await closing;
          assert.deepEqual(events, [...expected, "settled", "close"]);
          assert.equal(interrupts, 0, "shutdown must not publish an incomplete chain");
          assert.equal(view.getUint8(2048), 255);
          assert.equal(view.getUint8(2049), 255);
          assert.deepEqual(errors, []);
        } finally {
          finish.resolve();
          await (closing ?? close_virtio_device(device)).catch(() => {});
        }
      });
    }
  }
}
