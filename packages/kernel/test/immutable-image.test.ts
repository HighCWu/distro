// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { snapshot_block_storage } from "../src/immutable-image.ts";
import { blockDevice } from "../src/virtio/block.ts";
import { virtio_imports, close_virtio_device } from "../src/virtio/core.ts";

test("snapshot copies a source subarray, retains capacity and exposes no writer", () => {
  const source = new Uint8Array(1024).fill(7);
  source[0] = 99;
  const storage = snapshot_block_storage(source.subarray(512));
  source.fill(8);
  assert.equal(storage.capacity, 512);
  assert.equal(storage.write, undefined);
  assert.equal(storage.flush, undefined);
  assert.equal(Object.isFrozen(storage), true);
  const target = new Uint8Array(512);
  assert.equal(storage.read(0, target), 512);
  assert.equal(
    target.every((n) => n === 7),
    true,
  );
  target.fill(0);
  assert.equal(storage.read(0, target), 512);
  assert.equal(
    target.every((n) => n === 7),
    true,
  );
});

test("Node Buffer inputs are copied rather than sliced into a mutable alias", () => {
  const source = Buffer.alloc(512, 42);
  const storage = snapshot_block_storage(source);
  source.fill(11);
  const target = new Uint8Array(512);
  storage.read(0, target);
  assert.equal(
    target.every((n) => n === 42),
    true,
  );
});

test("overridden target.set cannot receive or retain a private backing view", () => {
  const storage = snapshot_block_storage(new Uint8Array(512).fill(3));
  const target = new Uint8Array(512);
  target.set = () => assert.fail("private view escaped");
  assert.equal(storage.read(0, target), 512);
  assert.equal(
    target.every((n) => n === 3),
    true,
  );
});

test("EOF is a short read, invalid offsets are refused and untouched tails stay intact", () => {
  const storage = snapshot_block_storage(new Uint8Array(512).fill(3));
  const target = new Uint8Array(8).fill(9);
  assert.equal(storage.read(510, target), 2);
  assert.deepEqual([...target], [3, 3, 9, 9, 9, 9, 9, 9]);
  assert.equal(storage.read(512, target), 0);
  assert.equal(storage.read(1024, target), 0);
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => storage.read(offset, target), RangeError);
});

test("snapshot bounds, alignment and non-shared source are required", () => {
  assert.throws(() => snapshot_block_storage(new Uint8Array(513)), RangeError);
  assert.throws(() => snapshot_block_storage(new Uint8Array(512), 511), RangeError);
  for (const bound of [-1, 0.5, NaN, Infinity])
    assert.throws(() => snapshot_block_storage(new Uint8Array(512), bound), RangeError);
  assert.throws(
    () => snapshot_block_storage(new Uint8Array(new SharedArrayBuffer(512))),
    TypeError,
  );
  assert.equal(snapshot_block_storage(new Uint8Array(0), 0).capacity, 0);
});

test("close revokes reads and repeated close is harmless", () => {
  const storage = snapshot_block_storage(new Uint8Array(512));
  storage.close?.();
  storage.close?.();
  assert.throws(() => storage.read(0, new Uint8Array(1)), /closed/);
  assert.equal(storage.capacity, 512);
});

test(
  "real virtio block queue serves frozen bytes and refuses writes",
  { timeout: 2000 },
  async () => {
    const source = new Uint8Array(512).fill(0x5a);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const device = blockDevice(snapshot_block_storage(source));
    source.fill(0xa5);
    let completion = Promise.withResolvers<void>();
    const imports = virtio_imports({
      memory,
      devices: [device],
      trigger_irq() {
        completion.resolve();
      },
      on_error(error) {
        completion.reject(error);
      },
    });
    const descriptor = (index: number, address: number, length: number, flags: number) => {
      const view = new DataView(memory.buffer, index * 16, 16);
      view.setBigUint64(0, BigInt(address), true);
      view.setUint32(8, length, true);
      view.setUint16(14, flags, true);
    };
    const available = 1 << 7,
      next = 1,
      writable = 1 << 1;
    descriptor(0, 128, 16, available | next);
    descriptor(1, 256, 512, available | next | writable);
    descriptor(2, 1024, 1, available | writable);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completion.promise;
    assert.equal(new Uint8Array(memory.buffer)[1024], 0);
    assert.equal(
      new Uint8Array(memory.buffer, 256, 512).every((n) => n === 0x5a),
      true,
    );
    completion = Promise.withResolvers<void>();
    imports.disable_vring(0, 0);
    new Uint8Array(memory.buffer, 256, 512).fill(0);
    new DataView(memory.buffer).setUint32(128, 1, true); // OUT
    descriptor(0, 128, 16, available | next);
    descriptor(1, 256, 512, available | next);
    descriptor(2, 1024, 1, available | writable);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completion.promise;
    assert.equal(new Uint8Array(memory.buffer)[1024], 2); // UNSUPP
    completion = Promise.withResolvers<void>();
    imports.disable_vring(0, 0);
    new DataView(memory.buffer).setUint32(128, 0, true); // IN again
    descriptor(0, 128, 16, available | next);
    descriptor(1, 256, 512, available | next | writable);
    descriptor(2, 1024, 1, available | writable);
    imports.enable_vring(0, 0, 4, 0, 1);
    imports.notify(0, 0);
    await completion.promise;
    assert.equal(
      new Uint8Array(memory.buffer, 256, 512).every((n) => n === 0x5a),
      true,
    );
    await close_virtio_device(device);
  },
);
