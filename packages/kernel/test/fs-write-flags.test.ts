// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("FUSE WRITE forwards current flags rather than the original OPEN flags", async () => {
  const root = {};
  const node = {};
  const handle = {};
  const flagsSeen: number[] = [];
  const device = fileSystemDevice(
    {
      root,
      lookup() {
        return node;
      },
      getattr() {
        return { mode: 0o100600, size: 0n };
      },
      open(_node: object, flags: number) {
        assert.equal(flags, 0x402);
        return handle;
      },
      write(
        actualNode: object,
        actualHandle: object,
        offset: bigint,
        data: Uint8Array,
        flags?: number,
      ) {
        assert.equal(actualNode, node);
        assert.equal(actualHandle, handle);
        assert.equal(offset, 7n);
        assert.deepEqual(data, Uint8Array.of(65));
        assert.notEqual(flags, undefined);
        flagsSeen.push(flags!);
        return data.length;
      },
      flush() {},
      fsync() {},
    },
    { tag: "test" },
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
    view.setUint16(14, 128 | 1, true);
    view.setBigUint64(16, 1024n, true);
    view.setUint32(24, 512, true);
    view.setUint16(30, 128 | 2, true);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completed.promise;
    imports.disable_vring(0, 0);
    assert.equal(view.getInt32(1028, true), 0);
    assert.equal(view.getBigUint64(1032, true), unique);
  }
  try {
    await request(1, 1n, new TextEncoder().encode("data\0"));
    const nodeid = view.getBigUint64(1040, true);
    const open = new Uint8Array(8);
    new DataView(open.buffer).setUint32(0, 0x402, true);
    await request(14, nodeid, open);
    const fh = view.getBigUint64(1040, true);
    for (const flags of [2, 0x402, 2]) {
      const body = new Uint8Array(41);
      const data = new DataView(body.buffer);
      data.setBigUint64(0, fh, true);
      data.setBigUint64(8, 7n, true);
      data.setUint32(16, 1, true);
      data.setUint32(32, flags, true);
      body[40] = 65;
      await request(16, nodeid, body);
      assert.equal(view.getUint32(1040, true), 1);
    }
    assert.deepEqual(flagsSeen, [2, 0x402, 2]);
  } finally {
    await close_virtio_device(device);
  }
});
