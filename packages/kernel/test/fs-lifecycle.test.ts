// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const operation of ["lookup", "open"] as const) {
  for (const outcome of ["success", "failure"] as const) {
    for (const stopMode of ["none", "normal", "cancel", "throws"] as const) {
      test(`FUSE shutdown drains ${operation} ${outcome}, stop=${stopMode}, without queued work`, async () => {
        const root = {};
        const node = {};
        const handle = {};
        const entered = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<void>();
        const events: string[] = [];
        const stopError = new Error("stop failed");
        let held = false;
        const device = fileSystemDevice(
          {
            root,
            async lookup() {
              events.push("lookup");
              if (held && operation === "lookup") {
                entered.resolve();
                await pending.promise;
              }
              return node;
            },
            getattr() {
              return { mode: 0o100600, size: 0n };
            },
            async open() {
              events.push("open");
              if (held && operation === "open") {
                entered.resolve();
                await pending.promise;
              }
              return handle;
            },
            stop:
              stopMode === "none"
                ? undefined
                : () => {
                    events.push("stop");
                    if (stopMode === "cancel") pending.reject(new Error("cancel requested"));
                    if (stopMode === "throws") throw stopError;
                  },
            release(actualNode: object, actualHandle: object) {
              assert.equal(actualNode, node);
              assert.equal(actualHandle, handle);
              events.push("release");
            },
            destroy() {
              events.push("destroy");
            },
          },
          { tag: "lifecycle" },
        );
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
        const bytes = new Uint8Array(memory.buffer);
        const view = new DataView(memory.buffer);
        let complete = Promise.withResolvers<void>();
        let interrupts = 0;
        const errors: unknown[] = [];
        const imports = virtio_imports({
          memory,
          devices: [device],
          trigger_irq() {
            interrupts++;
            complete.resolve();
          },
          on_error(error) {
            errors.push(error);
            complete.reject(error);
          },
        });
        function request(slot: number, opcode: number, nodeid: bigint, body: Uint8Array) {
          const address = 128 + slot * 128;
          const response = 1024 + slot * 1024;
          view.setUint32(address, 40 + body.length, true);
          view.setUint32(address + 4, opcode, true);
          view.setBigUint64(address + 8, BigInt(slot + 1), true);
          view.setBigUint64(address + 16, nodeid, true);
          bytes.set(body, address + 40);
          const descriptor = slot * 32;
          view.setBigUint64(descriptor, BigInt(address), true);
          view.setUint32(descriptor + 8, 40 + body.length, true);
          view.setUint16(descriptor + 14, 128 | 1, true);
          view.setBigUint64(descriptor + 16, BigInt(response), true);
          view.setUint32(descriptor + 24, 512, true);
          view.setUint16(descriptor + 30, 128 | 2, true);
        }
        let nodeid = 1n;
        if (operation === "open") {
          request(0, 1, 1n, new TextEncoder().encode("file\0"));
          imports.enable_vring(0, 0, 8, 0, 1);
          imports.notify(0, 0);
          await complete.promise;
          imports.disable_vring(0, 0);
          nodeid = view.getBigUint64(1040, true);
          assert.equal(view.getInt32(1028, true), 0);
        }
        bytes.fill(0);
        held = true;
        events.length = 0;
        interrupts = 0;
        complete = Promise.withResolvers<void>();
        const body =
          operation === "lookup" ? new TextEncoder().encode("file\0") : new Uint8Array(8);
        request(0, operation === "lookup" ? 1 : 14, nodeid, body);
        request(1, 1, 1n, new TextEncoder().encode("queued\0"));
        imports.enable_vring(0, 0, 8, 0, 1);
        imports.notify(0, 0);
        await entered.promise;
        let closed = false;
        const closing = close_virtio_device(device);
        const settled = closing.then(
          () => {
            closed = true;
          },
          () => {
            closed = true;
          },
        );
        await Promise.resolve();
        assert.equal(closed, false);
        const stopped = stopMode === "none" ? [] : ["stop"];
        assert.deepEqual(events, [operation, ...stopped]);
        const snapshot = bytes.slice();
        if (outcome === "failure") pending.reject(new Error("backend cancelled"));
        else pending.resolve();
        await settled;
        if (stopMode === "throws") {
          await assert.rejects(closing, (error) => error === stopError);
          await assert.rejects(close_virtio_device(device), (error) => error === stopError);
        } else {
          await closing;
          await close_virtio_device(device);
        }
        assert.deepEqual(events, [
          operation,
          ...stopped,
          ...(operation === "open" && outcome === "success" && stopMode !== "cancel"
            ? ["release"]
            : []),
          "destroy",
        ]);
        assert.deepEqual(
          bytes,
          snapshot,
          "late request must not write a response or complete descriptors",
        );
        assert.equal(interrupts, 0);
        assert.deepEqual(errors, []);
      });
    }
  }
}
