// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice } from "../src/virtio/block.ts";
import { close_virtio_device, virtio_imports, type VirtioDevice } from "../src/virtio/core.ts";

async function getIdentity(
  device: VirtioDevice,
  data: readonly { length: number; writable: boolean }[],
) {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const completed = Promise.withResolvers<void>();
  let completions = 0;
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {
      completions++;
      completed.resolve();
    },
    on_error(error) {
      completed.reject(error);
    },
  });
  const view = new DataView(memory.buffer),
    bytes = new Uint8Array(memory.buffer);
  function descriptor(index: number, address: number, length: number, flags: number) {
    view.setBigUint64(index * 16, BigInt(address), true);
    view.setUint32(index * 16 + 8, length, true);
    view.setUint16(index * 16 + 12, 0x1234, true);
    view.setUint16(index * 16 + 14, flags, true);
  }
  try {
    view.setUint32(128, 8, true);
    view.setBigUint64(136, 0xffffffffffffffffn, true);
    descriptor(0, 128, 16, 129);
    data.forEach(({ length, writable }, index) => {
      descriptor(index + 1, 256 + index * 128, length, 129 | (writable ? 2 : 0));
      bytes.fill(0xa5, 256 + index * 128, 256 + index * 128 + length);
    });
    descriptor(data.length + 1, 2048, 1, 130);
    view.setUint8(2048, 255);
    imports.enable_vring(0, 0, 8, 0, 1);
    imports.notify(0, 0);
    await completed.promise;
    assert.equal(completions, 1);
    assert.equal(view.getUint16(12, true), 0x1234);
    assert.equal(view.getUint16(14, true), (1 << 7) | (1 << 15) | 2);
    return {
      status: view.getUint8(2048),
      written: view.getUint32(8, true),
      data: data.map(({ length }, index) =>
        bytes.slice(256 + index * 128, 256 + index * 128 + length),
      ),
    };
  } finally {
    await close_virtio_device(device);
  }
}

test("block GET_ID snapshots a stable printable serial across writable scatter buffers", async () => {
  for (const serial of ["disk-root-01", "0123456789abcdefghij", " ~"]) {
    for (const lengths of [[20], [3, 7, 15], [0, 20, 8]]) {
      const storage = {
        capacity: 512,
        serial,
        read() {
          assert.fail("GET_ID must not read storage");
        },
      };
      const device = blockDevice(storage);
      storage.serial = "changed-after-creation";
      const result = await getIdentity(
        device,
        lengths.map((length) => ({ length, writable: true })),
      );
      assert.equal(result.status, 0);
      assert.equal(result.written, 21, "twenty identity bytes and one status byte");
      const actual = new Uint8Array(lengths.reduce((sum, length) => sum + length, 0));
      let position = 0;
      for (const part of result.data) {
        actual.set(part, position);
        position += part.length;
      }
      const expected = new Uint8Array(actual.length).fill(0xa5);
      expected.fill(0, 0, 20);
      expected.set(new TextEncoder().encode(serial));
      assert.deepEqual(actual, expected, "zero padding and unused data remain distinct");
    }
  }
});

test("identified block GET_ID rejects short or nonwritable scatter before data mutation", async () => {
  for (const data of [
    [{ length: 19, writable: true }],
    [{ length: 0, writable: true }],
    [
      { length: 10, writable: true },
      { length: 20, writable: false },
    ],
    [
      { length: 20, writable: true },
      { length: 1, writable: false },
    ],
  ]) {
    const device = blockDevice({
      capacity: 512,
      serial: "disk-id",
      read() {
        assert.fail("GET_ID must not read storage");
      },
    });
    const result = await getIdentity(device, data);
    assert.equal(result.status, 1);
    assert.equal(result.written, 1);
    result.data.forEach((bytes) =>
      assert.deepEqual(bytes, new Uint8Array(bytes.length).fill(0xa5)),
    );
  }
});

test("block serial rejects invalid length, control bytes and non-ASCII values", () => {
  for (const serial of [
    "",
    "x".repeat(21),
    "line\n",
    "tab\t",
    "\0",
    "\x1f",
    "\x7f",
    "磁盘",
    null,
    42,
  ])
    assert.throws(
      () => blockDevice({ capacity: 512, serial: serial as string, read: () => 0 }),
      RangeError,
    );
});

test("block GET_ID explicitly rejects unavailable identity without claiming output bytes", async () => {
  const device = blockDevice({
    capacity: 512,
    read() {
      assert.fail("GET_ID must not read storage");
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const completed = Promise.withResolvers<void>();
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
  function descriptor(index: number, address: number, size: number, flags: number) {
    view.setBigUint64(index * 16, BigInt(address), true);
    view.setUint32(index * 16 + 8, size, true);
    view.setUint16(index * 16 + 14, flags, true);
  }
  try {
    view.setUint32(128, 8, true);
    descriptor(0, 128, 16, 128 | 1);
    descriptor(1, 256, 20, 128 | 1 | 2);
    descriptor(2, 1024, 1, 128 | 2);
    bytes.fill(0xa5, 256, 276);
    view.setUint8(1024, 255);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completed.promise;
    assert.equal(view.getUint8(1024), 2, "UNSUPP, not a fabricated successful ID");
    assert.equal(view.getUint32(8, true), 1, "only status was written");
    assert.deepEqual(bytes.slice(256, 276), new Uint8Array(20).fill(0xa5));
    imports.disable_vring(0, 0);
  } finally {
    await close_virtio_device(device);
  }
});
