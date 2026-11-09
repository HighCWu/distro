// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

test("FUSE preserves arbitrary filename and symlink bytes through virtqueue operations", async () => {
  const root = {},
    handle = {},
    invalidByte = {},
    invalidFF = {},
    encodedSurrogate = {},
    replacement = {},
    boundary = {},
    symbolic = {},
    invalidBackendName = {};
  const invalidByteName = "\udc80";
  const invalidFFName = "\udcff";
  const encodedSurrogateName = "\udced\udca0\udc80";
  const replacementName = "\ufffd";
  const boundaryName = "\udc80".repeat(255);
  const renamedName = "\udc80-\udcff";
  const targetBytes = Uint8Array.of(0x80, 0xff, 0xed, 0xa0, 0x80, 0xef, 0xbf, 0xbd);
  const targetName = "\udc80\udcff\udced\udca0\udc80\ufffd";
  const encoder = new TextEncoder();
  const string = (value: string) => encoder.encode(value);
  const nul = (value: Uint8Array) => {
    const result = new Uint8Array(value.byteLength + 1);
    result.set(value);
    return result;
  };
  const join = (...values: Uint8Array[]) => {
    const result = new Uint8Array(values.reduce((length, value) => length + value.byteLength, 0));
    let offset = 0;
    for (const value of values) {
      result.set(value, offset);
      offset += value.byteLength;
    }
    return result;
  };
  const raw80 = Uint8Array.of(0x80);
  const rawFF = Uint8Array.of(0xff);
  const rawSurrogate = Uint8Array.of(0xed, 0xa0, 0x80);
  const rawReplacement = Uint8Array.of(0xef, 0xbf, 0xbd);
  const rawBoundary = new Uint8Array(255).fill(0x80);
  const rawRenamed = Uint8Array.of(0x80, 0x2d, 0xff);
  const files = new Map<string, object>([
    [invalidByteName, invalidByte],
    [invalidFFName, invalidFF],
    [encodedSurrogateName, encodedSurrogate],
    [replacementName, replacement],
    [boundaryName, boundary],
  ]);
  let symbolicTarget = "";
  let invalidDirectoryName = false;
  const directoryEntries = [
    { name: renamedName, node: invalidByte, type: "file" as const },
    { name: invalidFFName, node: invalidFF, type: "file" as const },
    { name: encodedSurrogateName, node: encodedSurrogate, type: "file" as const },
    { name: replacementName, node: replacement, type: "file" as const },
    { name: boundaryName, node: boundary, type: "file" as const },
    { name: "raw-link", node: symbolic, type: "symlink" as const },
  ];
  const device = fileSystemDevice(
    {
      root,
      lookup(_parent: object, name: string) {
        return files.get(name);
      },
      getattr(node: object) {
        return {
          mode: node === root ? 0o040755 : node === symbolic ? 0o120777 : 0o100600,
          size: 0n,
        };
      },
      rename(_oldParent: object, oldName: string, _newParent: object, newName: string) {
        assert.equal(oldName, invalidByteName);
        assert.equal(newName, renamedName);
        const node = files.get(oldName);
        assert.strictEqual(node, invalidByte);
        files.delete(oldName);
        files.set(newName, node);
      },
      symlink(_parent: object, name: string, target: string) {
        assert.equal(name, "raw-link");
        assert.equal(target, targetName);
        symbolicTarget = target;
        files.set(name, symbolic);
        return symbolic;
      },
      readlink(node: object) {
        assert.strictEqual(node, symbolic);
        return symbolicTarget;
      },
      opendir(node: object) {
        assert.strictEqual(node, root);
        return handle;
      },
      readdir(node: object, actualHandle: object) {
        assert.strictEqual(node, root);
        assert.strictEqual(actualHandle, handle);
        return invalidDirectoryName
          ? [{ name: "\ud800", node: invalidBackendName, type: "file" as const }]
          : directoryEntries;
      },
    },
    { tag: "byte-names" },
  );
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const bytes = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  let complete = Promise.withResolvers<void>();
  let unique = 0n;
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
  async function request(opcode: number, nodeid: bigint, body: Uint8Array, errno = 0) {
    complete = Promise.withResolvers<void>();
    bytes.fill(0);
    view.setUint32(128, 40 + body.byteLength, true);
    view.setUint32(132, opcode, true);
    view.setBigUint64(136, ++unique, true);
    view.setBigUint64(144, nodeid, true);
    bytes.set(body, 168);
    view.setBigUint64(0, 128n, true);
    view.setUint32(8, 40 + body.byteLength, true);
    view.setUint16(14, 129, true);
    view.setBigUint64(16, 1024n, true);
    view.setUint32(24, 4096, true);
    view.setUint16(30, 130, true);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await complete.promise;
    imports.disable_vring(0, 0);
    assert.equal(view.getInt32(1028, true), errno ? -errno : 0);
    assert.equal(view.getBigUint64(1032, true), unique);
    const length = view.getUint32(1024, true);
    return bytes.slice(1040, 1024 + length);
  }
  try {
    const lookupIds: bigint[] = [];
    for (const [rawName, node] of [
      [raw80, invalidByte],
      [rawFF, invalidFF],
      [rawSurrogate, encodedSurrogate],
      [rawReplacement, replacement],
      [rawBoundary, boundary],
    ] as const) {
      const payload = await request(1, 1n, nul(rawName));
      const id = new DataView(payload.buffer, payload.byteOffset).getBigUint64(0, true);
      lookupIds.push(id);
      assert.notEqual(id, 1n);
      assert.ok([...files.values()].includes(node));
    }
    assert.equal(new Set(lookupIds).size, lookupIds.length);
    assert.notEqual(invalidByteName, invalidFFName);
    assert.notEqual(encodedSurrogateName, replacementName);
    await request(1, 1n, nul(new Uint8Array(256).fill(0x80)), 36);
    for (const invalid of [new Uint8Array(), string("."), string(".."), string("/")]) {
      await request(1, 1n, nul(invalid), 22);
    }

    const renameBody = new Uint8Array(8);
    new DataView(renameBody.buffer).setBigUint64(0, 1n, true);
    await request(12, 1n, join(renameBody, nul(raw80), nul(rawRenamed)));
    assert.equal(files.has(invalidByteName), false);
    assert.strictEqual(files.get(renamedName), invalidByte);

    await request(6, 1n, join(nul(string("raw-link")), nul(targetBytes)));
    assert.equal(symbolicTarget, targetName);
    const link = await request(1, 1n, nul(string("raw-link")));
    const linkId = new DataView(link.buffer, link.byteOffset).getBigUint64(0, true);
    assert.deepEqual(await request(5, linkId, new Uint8Array()), targetBytes);

    const directory = await request(27, 1n, new Uint8Array(8));
    const directoryHandle = new DataView(directory.buffer, directory.byteOffset).getBigUint64(
      0,
      true,
    );
    const readdirBody = new Uint8Array(40);
    const readdir = new DataView(readdirBody.buffer);
    readdir.setBigUint64(0, directoryHandle, true);
    readdir.setBigUint64(8, 0n, true);
    readdir.setUint32(16, 2048, true);
    const entries = await request(28, 1n, readdirBody);
    const names: Uint8Array[] = [];
    for (let offset = 0; offset < entries.byteLength;) {
      const entry = new DataView(entries.buffer, entries.byteOffset + offset);
      const length = entry.getUint32(16, true);
      names.push(entries.slice(offset + 24, offset + 24 + length));
      offset += (24 + length + 7) & ~7;
    }
    assert.deepEqual(names, [
      string("."),
      string(".."),
      rawRenamed,
      rawFF,
      rawSurrogate,
      rawReplacement,
      rawBoundary,
      string("raw-link"),
    ]);

    invalidDirectoryName = true;
    await request(28, 1n, readdirBody, 22);
  } finally {
    await close_virtio_device(device);
  }
});
