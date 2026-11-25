// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice, type BlockDeviceStorage } from "../src/virtio/block.ts";
import {
  close_virtio_device,
  virtio_device_description,
  virtio_imports,
} from "../src/virtio/core.ts";

function range(sector = 0n, count = 1, flags = 0): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, sector, true);
  view.setUint32(8, count, true);
  view.setUint32(12, flags, true);
  return bytes;
}

function fixture(storage: BlockDeviceStorage) {
  const device = blockDevice(storage);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const view = new DataView(memory.buffer);
  let completion = Promise.withResolvers<void>();
  let interrupts = 0;
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {
      interrupts++;
      completion.resolve();
    },
    on_error(error) {
      completion.reject(error);
    },
  });
  function queue(parts: { bytes: Uint8Array; writable?: boolean }[]) {
    view.setUint32(512, 11, true);
    // Only the range payload supplies the extent for DISCARD.
    view.setBigUint64(520, 0xffffffffffffffffn, true);
    const descriptors = [
      { address: 512, bytes: new Uint8Array(memory.buffer, 512, 16), flags: 1 },
      ...parts.map((part, index) => ({
        address: 1024 + index * 128,
        bytes: part.bytes,
        flags: 1 | (part.writable ? 2 : 0),
      })),
      { address: 4096, bytes: new Uint8Array([255]), flags: 2 },
    ];
    descriptors.forEach(({ address, bytes, flags }, index) => {
      new Uint8Array(memory.buffer, address, bytes.length).set(bytes);
      view.setBigUint64(index * 16, BigInt(address), true);
      view.setUint32(index * 16 + 8, bytes.length, true);
      view.setUint16(index * 16 + 12, 17 + index, true);
      view.setUint16(index * 16 + 14, 128 | flags, true);
    });
    completion = Promise.withResolvers<void>();
    imports.enable_vring(0, 0, 16, 0, 1);
    imports.notify(0, 0);
  }
  return {
    device,
    imports,
    view,
    queue,
    get interrupts() {
      return interrupts;
    },
    async request(parts: { bytes: Uint8Array; writable?: boolean }[]) {
      queue(parts);
      await completion.promise;
      assert.equal(view.getUint32(8, true), 1);
      assert.equal(view.getUint16(12, true), 17);
      assert.equal(view.getUint16(14, true), (1 << 7) | (1 << 15) | 2);
      imports.disable_vring(0, 0);
      return view.getUint8(4096);
    },
    close: () => close_virtio_device(device),
  };
}

test("DISCARD advertises its standard range limits only with an explicit writable backend", async () => {
  for (const writable of [false, true])
    for (const capable of [false, true]) {
      let calls = 0;
      const io = fixture({
        capacity: 4096,
        read: () => 0,
        write: writable ? (_offset, bytes) => bytes.length : undefined,
        discard: capable
          ? () => {
              calls++;
            }
          : undefined,
      });
      try {
        const enabled = writable && capable;
        const { config, features } = virtio_device_description(io.device);
        assert.equal(!!(features & (1n << 13n)), enabled);
        assert.equal(!!(features & (1n << 14n)), false);
        assert.equal(!!(features & (1n << 5n)), !writable);
        if (enabled) {
          const fields = new DataView(config.buffer, config.byteOffset, config.byteLength);
          assert.equal(fields.getBigUint64(0, true), 8n);
          assert.equal(fields.getUint32(36, true), 2048);
          assert.equal(fields.getUint32(40, true), 1);
          assert.equal(fields.getUint32(44, true), 1);
          assert.deepEqual(config.slice(8, 36), new Uint8Array(28));
        }
        assert.equal(await io.request([{ bytes: range() }]), enabled ? 0 : writable ? 2 : 1);
        assert.equal(calls, enabled ? 1 : 0);
      } finally {
        await io.close();
      }
    }
});

test("DISCARD split range dispatch preserves unrelated storage and coexists with WRITE_ZEROES", async () => {
  const bytes = new Uint8Array(4096).fill(0xa5);
  const calls: number[][] = [];
  const io = fixture({
    capacity: bytes.length,
    read: () => 0,
    write: (_offset, value) => value.length,
    discard(offset, length) {
      assert.equal(this.capacity, bytes.length);
      calls.push([offset, length]);
      bytes.fill(0, offset, offset + length);
    },
    writeZeroes() {
      assert.fail("discard must not dispatch to writeZeroes");
    },
  });
  try {
    const { features, config } = virtio_device_description(io.device);
    assert.equal(features & ((1n << 13n) | (1n << 14n)), (1n << 13n) | (1n << 14n));
    const fields = new DataView(config.buffer, config.byteOffset, config.byteLength);
    assert.equal(fields.getUint32(36, true), 2048);
    assert.equal(fields.getUint32(48, true), 2048);
    assert.equal(fields.getUint32(52, true), 1);
    const payload = range(1n, 2);
    assert.equal(
      await io.request([{ bytes: payload.subarray(0, 3) }, { bytes: payload.subarray(3) }]),
      0,
    );
    assert.deepEqual(calls, [[512, 1024]]);
    assert.deepEqual(bytes.slice(0, 512), new Uint8Array(512).fill(0xa5));
    assert.deepEqual(bytes.slice(512, 1536), new Uint8Array(1024));
    assert.deepEqual(bytes.slice(1536), new Uint8Array(2560).fill(0xa5));
    assert.equal(io.interrupts, 1);
  } finally {
    await io.close();
  }
});

test("DISCARD rejects bad shape, direction, reserved flags and out-of-range extents before dispatch", async () => {
  const calls: number[][] = [];
  const io = fixture({
    capacity: 4 * 1024 * 1024,
    read: () => 0,
    write: (_offset, data) => data.length,
    discard(offset, length) {
      calls.push([offset, length]);
    },
  });
  try {
    for (const parts of [
      [],
      [{ bytes: new Uint8Array(15) }],
      [{ bytes: new Uint8Array(17) }],
      [{ bytes: range() }, { bytes: range() }],
      [{ bytes: range(), writable: true }],
      [{ bytes: range(8192n) }],
      [{ bytes: range(8191n, 2) }],
      [{ bytes: range(0xffffffffffffffffn) }],
      [{ bytes: range(0x20000000000001n) }],
      [{ bytes: range(0n, 2049) }],
    ]) {
      assert.equal(await io.request(parts), 1);
      assert.deepEqual(calls, []);
    }
    for (const flags of [1, 2, 0x80000000]) {
      assert.equal(await io.request([{ bytes: range(0n, 1, flags) }]), 2);
      assert.deepEqual(calls, []);
    }
    assert.equal(await io.request([{ bytes: range(8192n, 0) }]), 0);
    assert.deepEqual(calls, []);
    assert.equal(await io.request([{ bytes: range(0n, 2048) }]), 0);
    assert.deepEqual(calls, [[0, 1024 * 1024]]);
  } finally {
    await io.close();
  }
});

test("DISCARD callback throw/rejection completes IOERR once and allows later requests", async () => {
  for (const asynchronous of [false, true]) {
    let fail = true;
    const io = fixture({
      capacity: 1024,
      read: () => 0,
      write: (_offset, data) => data.length,
      discard() {
        if (!fail) return;
        if (asynchronous) return Promise.reject(new Error("discard failed"));
        throw new Error("discard failed");
      },
    });
    try {
      assert.equal(await io.request([{ bytes: range() }]), 1);
      fail = false;
      assert.equal(await io.request([{ bytes: range(1n) }]), 0);
      assert.equal(io.interrupts, 2);
    } finally {
      await io.close();
    }
  }
});

test("DISCARD drains on close without publishing stopped success or failure", async () => {
  for (const rejects of [false, true]) {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const io = fixture({
      capacity: 1024,
      read: () => 0,
      write: (_offset, data) => data.length,
      async discard() {
        events.push("entered");
        entered.resolve();
        await finish.promise;
        events.push("settled");
        if (rejects) throw new Error("stopped discard");
      },
      stop() {
        events.push("stop");
      },
      close() {
        events.push("close");
      },
    });
    let closing: Promise<void> | undefined;
    try {
      io.queue([{ bytes: range() }]);
      await entered.promise;
      closing = io.close();
      assert.deepEqual(events, ["entered", "stop"]);
      finish.resolve();
      await closing;
      assert.deepEqual(events, ["entered", "stop", "settled", "close"]);
      assert.equal(io.interrupts, 0);
      assert.equal(io.view.getUint8(4096), 255);
      assert.equal(io.view.getUint16(14, true) & (1 << 15), 0);
    } finally {
      finish.resolve();
      await (closing ?? io.close());
    }
  }
});
