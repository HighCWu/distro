// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice, FSError } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const directory of [false, true]) {
  for (const rejects of [false, true]) {
    test(`FUSE release is consumed once across queues, directory=${directory}, rejects=${rejects}`, async () => {
      const root = {},
        node = {},
        handle = {};
      const entered = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      let releases = 0;
      async function release(actualNode: object, actualHandle: object) {
        assert.equal(actualNode, node);
        assert.equal(actualHandle, handle);
        releases++;
        if (releases === 1) {
          entered.resolve();
          await pending.promise;
        }
        if (rejects) throw new FSError("EIO");
      }
      const device = fileSystemDevice(
        {
          root,
          lookup() {
            return node;
          },
          getattr() {
            return { mode: directory ? 0o040700 : 0o100600, size: 0n };
          },
          open() {
            return handle;
          },
          opendir() {
            return handle;
          },
          release,
          releasedir: release,
        },
        { tag: "release-errors" },
      );
      const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
      const bytes = new Uint8Array(memory.buffer),
        view = new DataView(memory.buffer);
      const completions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      const imports = virtio_imports({
        memory,
        devices: [device],
        trigger_irq(irq: number) {
          completions[irq - 1]!.resolve();
        },
        on_error(error) {
          for (const one of completions) one.reject(error);
        },
      });
      async function request(
        queue: number,
        opcode: number,
        nodeid: bigint,
        body: Uint8Array,
        errno = 0,
      ) {
        const descriptors = queue * 64,
          address = 512 + queue * 512,
          response = 2048 + queue * 1024;
        completions[queue] = Promise.withResolvers<void>();
        bytes.fill(0, descriptors, descriptors + 64);
        bytes.fill(0, address, address + 256);
        bytes.fill(0, response, response + 512);
        view.setUint32(address, 40 + body.length, true);
        view.setUint32(address + 4, opcode, true);
        view.setBigUint64(address + 8, BigInt(queue + 1), true);
        view.setBigUint64(address + 16, nodeid, true);
        bytes.set(body, address + 40);
        view.setBigUint64(descriptors, BigInt(address), true);
        view.setUint32(descriptors + 8, 40 + body.length, true);
        view.setUint16(descriptors + 14, 129, true);
        view.setBigUint64(descriptors + 16, BigInt(response), true);
        view.setUint32(descriptors + 24, 512, true);
        view.setUint16(descriptors + 30, 130, true);
        imports.enable_vring(0, queue, 4, descriptors, queue + 1);
        imports.notify(0, queue);
        await completions[queue]!.promise;
        imports.disable_vring(0, queue);
        if (opcode !== 2) assert.equal(view.getInt32(response + 4, true), -errno || 0);
      }
      try {
        await request(0, 1, 1n, new TextEncoder().encode("file\0"));
        const nodeid = view.getBigUint64(2064, true);
        await request(0, directory ? 27 : 14, nodeid, new Uint8Array(8));
        const fh = view.getBigUint64(2064, true);
        const body = new Uint8Array(24);
        new DataView(body.buffer).setBigUint64(0, fh, true);
        const first = request(0, directory ? 29 : 18, nodeid, body, rejects ? 5 : 0);
        await entered.promise;
        try {
          await request(1, directory ? 29 : 18, nodeid, body, 9);
        } finally {
          pending.resolve();
        }
        await first;
        await request(1, directory ? 29 : 18, nodeid, body, 9);
        assert.equal(releases, 1, "a consumed release cannot invoke backend cleanup again");
        const forget = new Uint8Array(8);
        new DataView(forget.buffer).setBigUint64(0, 1n, true);
        await request(1, 2, nodeid, forget);
        await request(1, 3, nodeid, new Uint8Array(16), 2);
      } finally {
        pending.resolve();
        await close_virtio_device(device);
      }
      assert.equal(releases, 1, "shutdown cannot retry a consumed failed release");
    });
  }
}
