// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice, type FSSetAttributes } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("FUSE SETATTR decodes signed time64 without changing unsigned sizes or NOW flags", async () => {
  const root = {};
  const node = {};
  let observed: FSSetAttributes = {};
  let seconds = 0n;
  const device = fileSystemDevice(
    {
      root,
      lookup() {
        return node;
      },
      getattr() {
        return {
          mode: 0o100600,
          size: 0n,
          atime: { seconds },
          mtime: { seconds },
          ctime: { seconds },
        };
      },
      setattr(_node: object, changes: FSSetAttributes) {
        assert.equal(_node, node);
        observed = changes;
        return this.getattr();
      },
    },
    { tag: "timestamps" },
  );
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  let completed = Promise.withResolvers<void>();
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
  let unique = 0n;
  async function request(opcode: number, nodeid: bigint, body: Uint8Array) {
    completed = Promise.withResolvers<void>();
    bytes.fill(0, 0, 4096);
    view.setUint32(128, 40 + body.length, true);
    view.setUint32(132, opcode, true);
    view.setBigUint64(136, ++unique, true);
    view.setBigUint64(144, nodeid, true);
    bytes.set(body, 168);
    view.setBigUint64(0, 128n, true);
    view.setUint32(8, 40 + body.length, true);
    view.setUint16(14, 129, true);
    view.setBigUint64(16, 1024n, true);
    view.setUint32(24, 512, true);
    view.setUint16(30, 130, true);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completed.promise;
    imports.disable_vring(0, 0);
    assert.equal(view.getInt32(1028, true), 0);
    assert.equal(view.getBigUint64(1032, true), unique);
  }
  try {
    await request(1, 1n, new TextEncoder().encode("file\0"));
    const id = view.getBigUint64(1040, true);
    const body = new Uint8Array(88);
    const input = new DataView(body.buffer);
    input.setUint32(0, 8 | 16 | 32 | 1024, true);
    input.setBigUint64(16, 1n << 63n, true);
    for (const value of [0n, 1n, -1n, -2n, -(1n << 63n), (1n << 63n) - 1n]) {
      seconds = value;
      for (const offset of [32, 40, 48]) input.setBigInt64(offset, value, true);
      for (const offset of [56, 60, 64]) input.setUint32(offset, 250000000, true);
      await request(4, id, body);
      assert.deepEqual(observed, {
        size: 1n << 63n,
        atime: { seconds: value, nanoseconds: 250000000 },
        mtime: { seconds: value, nanoseconds: 250000000 },
        ctime: { seconds: value, nanoseconds: 250000000 },
      });
      // FUSE attr_out has a 16-byte prefix before fuse_attr. Its time slots
      // round-trip the same signed bit pattern back to the Linux client.
      for (const offset of [1080, 1088, 1096]) assert.equal(view.getBigInt64(offset, true), value);
    }
    input.setUint32(0, 16 | 32 | 128 | 256, true);
    await request(4, id, body);
    assert.deepEqual(observed, { atime: "now", mtime: "now" });
  } finally {
    await close_virtio_device(device);
  }
});
