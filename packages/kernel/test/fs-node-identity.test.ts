// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("FUSE forget releases records but preserves a live backend node's inode identity", async () => {
  const root = {};
  const directory = {};
  let child = {};
  const device = fileSystemDevice(
    {
      root,
      lookup(parent: object, name: string) {
        if (parent === root && name === "directory") return directory;
        if (parent === directory && name === "file") return child;
      },
      getattr(node: object) {
        return { mode: node === child ? 0o100600 : 0o040700, size: 0n };
      },
    },
    { tag: "identity", cache: false },
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
  async function request(opcode: number, nodeid: bigint, body: Uint8Array, errno = 0) {
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
    if (opcode === 2 || opcode === 42) {
      assert.equal(view.getUint32(8, true), 0, "FORGET has no FUSE response");
    } else {
      assert.equal(view.getInt32(1028, true), errno === 0 ? 0 : -errno);
      assert.equal(view.getBigUint64(1032, true), unique);
    }
  }
  async function lookup(parent: bigint, name: string) {
    await request(1, parent, new TextEncoder().encode(`${name}\0`));
    const id = view.getBigUint64(1040, true);
    assert.equal(view.getBigUint64(1080, true), id, "entry attr.ino matches nodeid");
    return id;
  }
  async function forget(id: bigint) {
    const body = new Uint8Array(8);
    new DataView(body.buffer).setBigUint64(0, 1n, true);
    await request(2, id, body);
  }
  async function absent(id: bigint) {
    await request(3, id, new Uint8Array(16), 2);
  }
  try {
    const directoryId = await lookup(1n, "directory");
    const childId = await lookup(directoryId, "file");
    assert.equal(await lookup(directoryId, "file"), childId);
    await forget(childId);
    await request(3, childId, new Uint8Array(16));
    assert.equal(view.getBigUint64(1056, true), childId);
    await forget(childId);
    await absent(childId); // No resurrection from a stale nodeid alone.
    assert.equal(await lookup(directoryId, "file"), childId);

    await forget(directoryId); // The child keeps its parent record alive.
    await request(3, directoryId, new Uint8Array(16));
    await forget(childId); // Recursively collect the now-unreferenced parent.
    await absent(childId);
    await absent(directoryId);
    assert.equal(await lookup(1n, "directory"), directoryId);
    assert.equal(await lookup(directoryId, "file"), childId);

    // BATCH_FORGET follows the same record lifetime rules.
    const batch = new Uint8Array(40);
    const data = new DataView(batch.buffer);
    data.setUint32(0, 2, true);
    data.setBigUint64(8, directoryId, true);
    data.setBigUint64(16, 1n, true);
    data.setBigUint64(24, childId, true);
    data.setBigUint64(32, 1n, true);
    await request(42, 0n, batch);
    await absent(childId);
    await absent(directoryId);
    assert.equal(await lookup(1n, "directory"), directoryId);
    assert.equal(await lookup(directoryId, "file"), childId);

    await forget(childId);
    child = {}; // A replacement backend object is a different inode.
    assert.notEqual(await lookup(directoryId, "file"), childId);
  } finally {
    await close_virtio_device(device);
  }
});
