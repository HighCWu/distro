// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { fileSystemDevice, FSError } from "../src/virtio/fs.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

for (const [asynchronous, typed] of [
  [false, false],
  [false, true],
  [true, false],
  [true, true],
]) {
  test(`FUSE readdir streams pages and closes iterators, async=${asynchronous}, typed=${typed}`, async () => {
    const root = {},
      nodes = [{}, {}, {}];
    let opened = 0,
      yielded = 0,
      closed = 0,
      attributes = 0;
    let failAttributes = false;
    let invalidType = false;
    function* entries() {
      opened++;
      try {
        for (const [index, node] of nodes.entries()) {
          yielded++;
          yield {
            name: String.fromCharCode(97 + index),
            node,
            type: typed ? ((invalidType ? "invalid" : "file") as "file") : undefined,
          };
        }
        throw new Error("must not traverse beyond the requested page");
      } finally {
        closed++;
      }
    }
    const device = fileSystemDevice(
      {
        root,
        lookup() {
          return undefined;
        },
        getattr(node: object) {
          attributes++;
          if (failAttributes && node !== root) throw new FSError("EACCES");
          return { mode: node === root ? 0o040700 : 0o100600, size: 0n };
        },
        opendir() {
          return {};
        },
        readdir() {
          if (!asynchronous) return entries();
          return (async function* () {
            yield* entries();
          })();
        },
      },
      { tag: "stream" },
    );
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const bytes = new Uint8Array(memory.buffer),
      view = new DataView(memory.buffer);
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
    async function request(opcode: number, body: Uint8Array, errno = 0) {
      complete = Promise.withResolvers<void>();
      bytes.fill(0);
      view.setUint32(128, 40 + body.length, true);
      view.setUint32(132, opcode, true);
      view.setBigUint64(136, 1n, true);
      view.setBigUint64(144, 1n, true);
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
      assert.equal(view.getInt32(1028, true), -errno || 0);
    }
    try {
      await request(27, new Uint8Array(8));
      const fh = view.getBigUint64(1040, true);
      async function page(offset: number, size: number, errno = 0) {
        const body = new Uint8Array(40),
          input = new DataView(body.buffer);
        input.setBigUint64(0, fh, true);
        input.setBigUint64(8, BigInt(offset), true);
        input.setUint32(16, size, true);
        await request(28, body, errno);
        const result: { name: string; offset: bigint; ino: bigint; type: number }[] = [];
        for (let cursor = 1040; cursor < 1024 + view.getUint32(1024, true);) {
          const length = view.getUint32(cursor + 16, true);
          result.push({
            name: new TextDecoder().decode(bytes.subarray(cursor + 24, cursor + 24 + length)),
            offset: view.getBigUint64(cursor + 8, true),
            ino: view.getBigUint64(cursor, true),
            type: view.getUint32(cursor + 20, true),
          });
          cursor += (24 + length + 7) & ~7;
        }
        return result;
      }
      assert.deepEqual(
        (await page(0, 64)).map((e) => e.name),
        [".", ".."],
      );
      assert.equal(opened, 0, "a full dot-entry page must not open the backend iterator");
      const first = await page(2, 32);
      assert.equal(first[0]!.name, "a");
      assert.equal(first[0]!.offset, 3n);
      assert.equal(first[0]!.type, 8, "regular-file d_type is preserved");
      assert.deepEqual([opened, yielded, closed, attributes], [1, 1, 1, typed ? 2 : 3]);
      const remaining = await page(3, 64);
      assert.deepEqual(
        remaining.map((e) => [e.name, e.offset]),
        [
          ["b", 4n],
          ["c", 5n],
        ],
      );
      assert.deepEqual([opened, yielded, closed, attributes], [2, 4, 2, typed ? 2 : 5]);
      assert.equal((await page(2, 32))[0]!.ino, first[0]!.ino, "stable inode across pages");
      failAttributes = true;
      const withoutMetadata = await page(2, 32, typed ? 0 : 13);
      if (typed) {
        assert.equal(withoutMetadata[0]!.name, "a", "typed entries do not require stat");
        assert.equal(attributes, 2, "only dot entries needed getattr");
        invalidType = true;
        await page(2, 32, 5);
      }
      assert.equal(closed, opened, "attribute failure also closes the backend iterator");
    } finally {
      await close_virtio_device(device);
    }
  });
}
