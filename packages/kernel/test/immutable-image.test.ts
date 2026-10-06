// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  snapshot_block_storage,
  snapshot_block_device,
  snapshot_device_tree_properties,
  merge_snapshot_device_tree,
} from "../src/immutable-image.ts";
import { blockDevice } from "../src/virtio/block.ts";
import {
  virtio_imports,
  close_virtio_device,
  virtio_device_description,
  VirtioController,
} from "../src/virtio/core.ts";
import { serveDevice, workerDevice } from "../src/virtio/remote.ts";
import { generate_devicetree } from "../src/devicetree.ts";
import type { DeviceTreeNode } from "../src/devicetree.ts";

test("plugin merge cannot forge provenance or redirect a snapshot transport", async () => {
  const snapshot = snapshot_block_device(new Uint8Array(512));
  const ordinary = blockDevice(snapshot_block_storage(new Uint8Array(512)));
  const devices = [snapshot, ordinary];
  const tree = (): DeviceTreeNode =>
    Object.fromEntries(
      devices.map((device, i) => {
        const description = virtio_device_description(device);
        return [
          `virtio${i}`,
          {
            compatible: "virtio,wasm",
            "host-id": i,
            "virtio-device-id": description.device_id,
            features: description.features,
            config: description.config,
          },
        ];
      }),
    );
  try {
    for (const fragment of [
      { virtio1: { "lowland,snapshot-image-v1": 1 } },
      { added: { nested: { "lowland,snapshot-image-v1": 1 } } },
      { virtio0: { "lowland,snapshot-image-v1": undefined } },
      ...["compatible", "host-id", "virtio-device-id", "features", "config"].map((key) => ({
        virtio0: { [key]: 1 },
      })),
      { virtio0: undefined },
      { virtio0: "replacement" },
    ] as DeviceTreeNode[]) {
      const target = tree();
      const before = structuredClone(target);
      assert.throws(
        () => merge_snapshot_device_tree(target, fragment, devices),
        /reserved|identity/,
      );
      assert.deepEqual(target, before); // no partially applied configuration
    }
    const target = tree();
    merge_snapshot_device_tree(
      target,
      { virtio0: { status: "okay" }, custom: { value: 9 } },
      devices,
    );
    assert.equal((target.virtio0 as DeviceTreeNode)["lowland,snapshot-image-v1"], 1);
    assert.equal((target.virtio1 as DeviceTreeNode)["lowland,snapshot-image-v1"], undefined);
    assert.equal((target.virtio0 as DeviceTreeNode)["host-id"], 0);
    assert.equal((target.custom as DeviceTreeNode).value, 9);
    await close_virtio_device(snapshot);
    const closed = tree();
    merge_snapshot_device_tree(closed, {}, devices);
    assert.equal((closed.virtio0 as DeviceTreeNode)["lowland,snapshot-image-v1"], undefined);
  } finally {
    await Promise.all(devices.map(close_virtio_device));
  }
});

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

test("boot provenance is bound to the exact factory device, not read-only storage or config", async () => {
  const image = new Uint8Array(512).fill(7);
  const snapshot = snapshot_block_device(image);
  const ordinary = blockDevice(snapshot_block_storage(image));
  const description = virtio_device_description(snapshot);
  const lookalike = new VirtioController(
    {
      deviceId: description.device_id,
      features: description.features,
      config: description.config.slice(),
    },
    { queues: [() => {}] },
  ).device;
  try {
    assert.deepEqual(snapshot_device_tree_properties(snapshot), { "lowland,snapshot-image-v1": 1 });
    assert.deepEqual(snapshot_device_tree_properties(ordinary), {});
    assert.deepEqual(snapshot_device_tree_properties(lookalike), {});
    assert.deepEqual(snapshot_device_tree_properties({ ...snapshot }), {});
    const properties = snapshot_device_tree_properties(snapshot);
    properties["lowland,snapshot-image-v1"] = 99;
    assert.equal(snapshot_device_tree_properties(snapshot)["lowland,snapshot-image-v1"], 1);
    await close_virtio_device(snapshot);
    assert.deepEqual(snapshot_device_tree_properties(snapshot), {});
  } finally {
    await Promise.all([snapshot, ordinary, lookalike].map(close_virtio_device));
  }
});

test(
  "remote ready descriptions do not transfer local snapshot provenance",
  { timeout: 2000 },
  async () => {
    const local = snapshot_block_device(new Uint8Array(512));
    const channel = new MessageChannel();
    serveDevice(channel.port1, local);
    const remote = await workerDevice(channel.port2);
    try {
      assert.equal(snapshot_device_tree_properties(local)["lowland,snapshot-image-v1"], 1);
      assert.deepEqual(snapshot_device_tree_properties(remote), {});
      await close_virtio_device(remote);
      assert.deepEqual(snapshot_device_tree_properties(local), {});
    } finally {
      await close_virtio_device(remote);
      channel.port1.close();
      channel.port2.close();
    }
  },
);

test("boot provenance is encoded as a versioned u32 in either root cell width", async () => {
  const device = snapshot_block_device(new Uint8Array(512));
  try {
    for (const cells of [1, 2]) {
      const blob = generate_devicetree({
        "#address-cells": cells,
        "#size-cells": cells,
        virtio2: { "host-id": 2, ...snapshot_device_tree_properties(device) },
      });
      const bytes = new Uint8Array(blob);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const strings_offset = view.getUint32(12);
      const structure_offset = view.getUint32(8);
      let found = false;
      for (let offset = structure_offset; offset < strings_offset; offset += 4) {
        if (view.getUint32(offset) !== 3) continue; // FDT_PROP
        const length = view.getUint32(offset + 4);
        const name_offset = strings_offset + view.getUint32(offset + 8);
        const end = bytes.indexOf(0, name_offset);
        if (
          new TextDecoder().decode(bytes.subarray(name_offset, end)) !== "lowland,snapshot-image-v1"
        )
          continue;
        assert.equal(length, 4);
        assert.equal(view.getUint32(offset + 12), 1);
        found = true;
        break;
      }
      assert.equal(found, true);
    }
  } finally {
    await close_virtio_device(device);
  }
});

test(
  "real virtio block queue serves frozen bytes and refuses writes",
  { timeout: 2000 },
  async () => {
    const source = new Uint8Array(512).fill(0x5a);
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const device = snapshot_block_device(source);
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
    assert.deepEqual(snapshot_device_tree_properties(device), {});
  },
);
