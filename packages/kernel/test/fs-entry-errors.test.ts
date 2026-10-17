// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice, FSError } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const opcode of [1, 6, 9, 35]) {
  for (const existing of [false, true]) {
    for (const releaseFails of opcode === 35 ? [false, true] : [false]) {
      test(`FUSE entry ${opcode} rolls back failed attributes, existing=${existing}, cleanup fails=${releaseFails}`, async () => {
        const root = {};
        const node = {};
        const handle = {};
        let failAttributes = false;
        let releases = 0;
        const device = fileSystemDevice(
          {
            root,
            lookup() {
              return node;
            },
            getattr() {
              if (failAttributes) throw new FSError("EACCES", "attribute failure");
              return { mode: 0o100600, size: 0n };
            },
            symlink() {
              return node;
            },
            mkdir() {
              return node;
            },
            create() {
              return { node, handle };
            },
            flush() {},
            fsync() {},
            release(actualNode: object, actualHandle: object) {
              assert.equal(actualNode, node);
              assert.equal(actualHandle, handle);
              releases++;
              if (releaseFails) throw new FSError("EIO", "release failed");
            },
          },
          { tag: "entry-errors" },
        );
        const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
        const bytes = new Uint8Array(memory.buffer);
        const view = new DataView(memory.buffer);
        let complete = Promise.withResolvers<void>();
        const imports = virtio_imports({
          memory,
          devices: [device],
          trigger_irq() {
            complete.resolve();
          },
          on_error(error) {
            complete.reject(error);
          },
        });
        async function request(op: number, id: bigint, body: Uint8Array, error = 0) {
          complete = Promise.withResolvers<void>();
          bytes.fill(0);
          view.setUint32(128, 40 + body.length, true);
          view.setUint32(132, op, true);
          view.setBigUint64(136, 1n, true);
          view.setBigUint64(144, id, true);
          bytes.set(body, 168);
          view.setBigUint64(0, 128n, true);
          view.setUint32(8, 40 + body.length, true);
          view.setUint16(14, 129, true);
          view.setBigUint64(16, 1024n, true);
          view.setUint32(24, 512, true);
          view.setUint16(30, 130, true);
          imports.enable_vring(0, 0, 4, 0, 1);
          imports.notify(0, 0);
          await complete.promise;
          imports.disable_vring(0, 0);
          if (op !== 2) assert.equal(view.getInt32(1028, true), -error || 0);
        }
        const name = new TextEncoder().encode("file\0");
        try {
          if (existing) await request(1, 1n, name);
          const body = new Uint8Array(
            (opcode === 9 ? 8 : opcode === 35 ? 16 : 0) + name.length + (opcode === 6 ? 7 : 0),
          );
          body.set(name, opcode === 9 ? 8 : opcode === 35 ? 16 : 0);
          if (opcode === 6) body.set(new TextEncoder().encode("target\0"), name.length);
          failAttributes = true;
          await request(opcode, 1n, body, 13);
          assert.equal(
            releases,
            opcode === 35 ? 1 : 0,
            "CREATE failure releases its unpublished handle immediately",
          );
          failAttributes = false;
          await request(3, 2n, new Uint8Array(16), existing ? 0 : 2);
          await request(1, 1n, name);
          assert.equal(
            view.getBigUint64(1040, true),
            2n,
            "live backend inode identity survives record collection",
          );
          const forget = new Uint8Array(8);
          new DataView(forget.buffer).setBigUint64(0, existing ? 2n : 1n, true);
          await request(2, 2n, forget);
          await request(3, 2n, new Uint8Array(16), 2);
        } finally {
          await close_virtio_device(device);
        }
        assert.equal(
          releases,
          opcode === 35 ? 1 : 0,
          "shutdown must not retry an unpublished failed CREATE handle",
        );
      });
    }
  }
}
