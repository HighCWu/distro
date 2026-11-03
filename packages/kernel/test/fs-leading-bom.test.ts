// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("FUSE names and symlink targets keep leading U+FEFF distinct from plain names", async () => {
  const root = {},
    plain = {},
    marked = {},
    symbolic = {};
  const names = new Map<string, object>([
    ["file", plain],
    ["\uFEFFfile", marked],
  ]);
  let target = "";
  const device = fileSystemDevice(
    {
      root,
      lookup(_parent: object, name: string) {
        return names.get(name);
      },
      getattr(node: object) {
        return { mode: node === symbolic ? 0o120777 : 0o100600, size: 0n };
      },
      unlink(_parent: object, name: string) {
        assert.equal(name, "\uFEFFrenamed");
        names.delete(name);
      },
      rename(_old: object, oldName: string, _next: object, newName: string) {
        assert.equal(oldName, "\uFEFFfile");
        assert.equal(newName, "\uFEFFrenamed");
        names.set(newName, names.get(oldName)!);
        names.delete(oldName);
      },
      symlink(_parent: object, name: string, value: string) {
        assert.equal(name, "\uFEFFlink");
        target = value;
        names.set(name, symbolic);
        return symbolic;
      },
      readlink() {
        return target;
      },
    },
    { tag: "names" },
  );
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const bytes = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  let done = Promise.withResolvers<void>(),
    unique = 0n;
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
  const string = (value: string) => new TextEncoder().encode(value + "\0");
  async function request(opcode: number, nodeid: bigint, body: Uint8Array) {
    done = Promise.withResolvers<void>();
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
    await done.promise;
    imports.disable_vring(0, 0);
    assert.equal(view.getInt32(1028, true), 0);
    assert.equal(view.getBigUint64(1032, true), unique);
  }
  try {
    await request(1, 1n, string("file"));
    const plainId = view.getBigUint64(1040, true);
    await request(1, 1n, string("\uFEFFfile"));
    const markedId = view.getBigUint64(1040, true);
    assert.notEqual(markedId, plainId);
    await request(6, 1n, new Uint8Array([...string("\uFEFFlink"), ...string("\uFEFFfile")]));
    const linkId = view.getBigUint64(1040, true);
    assert.equal(target, "\uFEFFfile");
    await request(5, linkId, new Uint8Array());
    assert.deepEqual(
      bytes.slice(1040, view.getUint32(1024, true) + 1024),
      string("\uFEFFfile").slice(0, -1),
    );
    const rename = new Uint8Array(8 + string("\uFEFFfile").length + string("\uFEFFrenamed").length);
    new DataView(rename.buffer).setBigUint64(0, 1n, true);
    rename.set(string("\uFEFFfile"), 8);
    rename.set(string("\uFEFFrenamed"), 8 + string("\uFEFFfile").length);
    await request(12, 1n, rename);
    await request(10, 1n, string("\uFEFFrenamed"));
    assert.equal(names.get("file"), plain);
    assert.equal(names.has("\uFEFFrenamed"), false);
  } finally {
    await close_virtio_device(device);
  }
});
