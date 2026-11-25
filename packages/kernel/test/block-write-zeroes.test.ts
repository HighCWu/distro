// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { blockDevice, type BlockDeviceStorage } from "../src/virtio/block.ts";
import {
  close_virtio_device,
  virtio_device_description,
  virtio_imports,
} from "../src/virtio/core.ts";

function range(sector: bigint, sectors: number, flags = 0) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, sector, true);
  view.setUint32(8, sectors, true);
  view.setUint32(12, flags, true);
  return bytes;
}

function fixture(storage: BlockDeviceStorage) {
  const device = blockDevice(storage);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const view = new DataView(memory.buffer);
  let completed = Promise.withResolvers<void>();
  let interrupts = 0;
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {
      interrupts++;
      completed.resolve();
    },
    on_error(error) {
      completed.reject(error);
    },
  });
  function descriptor(index: number, address: number, size: number, flags: number) {
    view.setBigUint64(index * 16, BigInt(address), true);
    view.setUint32(index * 16 + 8, size, true);
    view.setUint16(index * 16 + 14, 128 | flags, true);
  }
  function queue(
    payloads: { bytes: Uint8Array; writable?: boolean }[],
    request = 0,
    first = request * 5,
  ) {
    const header = 512 + request * 32;
    view.setUint32(header, 13, true);
    // WRITE_ZEROES uses the range payload, not this unused header field.
    view.setBigUint64(header + 8, 0xffffffffffffffffn, true);
    descriptor(first, header, 16, 1);
    payloads.forEach(({ bytes, writable }, index) => {
      const address = 1024 + request * 1024 + index * 128;
      new Uint8Array(memory.buffer, address, bytes.length).set(bytes);
      descriptor(first + index + 1, address, bytes.length, 1 | (writable ? 2 : 0));
    });
    const status = 4096 + request;
    descriptor(first + payloads.length + 1, status, 1, 2);
    view.setUint8(status, 255);
  }
  return {
    device,
    view,
    imports,
    queue,
    get interrupts() {
      return interrupts;
    },
    async request(payloads: { bytes: Uint8Array; writable?: boolean }[]) {
      completed = Promise.withResolvers<void>();
      queue(payloads);
      imports.enable_vring(0, 0, 16, 0, 1);
      imports.notify(0, 0);
      await completed.promise;
      const status = view.getUint8(4096);
      assert.equal(view.getUint32(8, true), 1, "only the status byte is device-written");
      imports.disable_vring(0, 0);
      return status;
    },
    close() {
      return close_virtio_device(device);
    },
  };
}

test("WRITE_ZEROES feature and standard config require an explicitly writable zeroing backend", async () => {
  for (const writable of [false, true]) {
    for (const capable of [false, true]) {
      let calls = 0;
      const io = fixture({
        capacity: 4096,
        read: () => 0,
        write: writable ? (_offset, bytes) => bytes.length : undefined,
        writeZeroes: capable
          ? () => {
              calls++;
            }
          : undefined,
      });
      try {
        const { features, config } = virtio_device_description(io.device);
        const enabled = writable && capable;
        assert.equal(!!(features & (1n << 14n)), enabled);
        assert.equal(!!(features & (1n << 13n)), false, "discard is not advertised");
        assert.equal(!!(features & (1n << 5n)), !writable);
        if (enabled) {
          const fields = new DataView(config.buffer, config.byteOffset, config.byteLength);
          assert.equal(fields.getBigUint64(0, true), 8n);
          assert.equal(fields.getUint32(48, true), 2048);
          assert.equal(fields.getUint32(52, true), 1);
          assert.equal(fields.getUint8(56), 0);
          assert.deepEqual(config.slice(8, 48), new Uint8Array(40));
        }
        assert.equal(await io.request([{ bytes: range(0n, 1) }]), enabled ? 0 : writable ? 2 : 1);
        assert.equal(calls, enabled ? 1 : 0);
      } finally {
        await io.close();
      }
    }
  }
});

test("WRITE_ZEROES decodes split descriptors, preserves surrounding bytes and accepts UNMAP as a hint", async () => {
  const bytes = new Uint8Array(4096).fill(0xa5);
  const calls: number[][] = [];
  const io = fixture({
    capacity: bytes.length,
    read() {
      assert.fail("zeroing must not read storage");
    },
    write() {
      assert.fail("zeroing uses its explicit backend operation");
    },
    writeZeroes(offset, length) {
      assert.equal(this.capacity, bytes.length, "backend method retains its receiver");
      calls.push([offset, length]);
      bytes.fill(0, offset, offset + length);
    },
  });
  try {
    const payload = range(1n, 2);
    assert.equal(
      await io.request([{ bytes: payload.subarray(0, 3) }, { bytes: payload.subarray(3) }]),
      0,
    );
    assert.equal(await io.request([{ bytes: range(5n, 1, 1) }]), 0);
    assert.deepEqual(calls, [
      [512, 1024],
      [2560, 512],
    ]);
    assert.deepEqual(bytes.slice(512, 1536), new Uint8Array(1024));
    assert.deepEqual(bytes.slice(2560, 3072), new Uint8Array(512));
    for (const [start, end] of [
      [0, 512],
      [1536, 2560],
      [3072, 4096],
    ] as const)
      assert.deepEqual(bytes.slice(start, end), new Uint8Array(end - start).fill(0xa5));
  } finally {
    await io.close();
  }
});

test("WRITE_ZEROES rejects malformed descriptors, flags and complete extents before any backend mutation", async () => {
  const calls: number[][] = [];
  const capacity = 4 * 1024 * 1024;
  const io = fixture({
    capacity,
    read: () => 0,
    write: (_offset, bytes) => bytes.length,
    writeZeroes(offset, length) {
      calls.push([offset, length]);
    },
  });
  const cases = [
    { payloads: [], status: 1 },
    { payloads: [{ bytes: new Uint8Array(15) }], status: 1 },
    { payloads: [{ bytes: new Uint8Array(17) }], status: 1 },
    { payloads: [{ bytes: range(0n, 1) }, { bytes: range(1n, 1) }], status: 1 },
    { payloads: [{ bytes: range(0n, 1), writable: true }], status: 1 },
    { payloads: [{ bytes: range(BigInt(capacity / 512), 1) }], status: 1 },
    { payloads: [{ bytes: range(BigInt(capacity / 512 - 1), 2) }], status: 1 },
    { payloads: [{ bytes: range(0xffffffffffffffffn, 1) }], status: 1 },
    { payloads: [{ bytes: range(0x20000000000001n, 1) }], status: 1 },
    { payloads: [{ bytes: range(0n, 2049) }], status: 1 },
    { payloads: [{ bytes: range(0n, 0xffffffff) }], status: 1 },
    { payloads: [{ bytes: range(0n, 1, 2) }], status: 2 },
    { payloads: [{ bytes: range(0n, 1, 0x80000000) }], status: 2 },
  ];
  try {
    for (const { payloads, status } of cases) {
      assert.equal(await io.request(payloads), status);
      assert.deepEqual(calls, []);
    }
    assert.equal(await io.request([{ bytes: range(BigInt(capacity / 512), 0) }]), 0);
    assert.deepEqual(calls, [], "empty valid range performs no backend work");
    assert.equal(await io.request([{ bytes: range(0n, 2048) }]), 0);
    assert.deepEqual(calls, [[0, 1024 * 1024]], "advertised maximum works after rejection");
  } finally {
    await io.close();
  }
});

for (const asynchronous of [false, true]) {
  test(`WRITE_ZEROES reports backend ${asynchronous ? "rejection" : "throw"} as IOERR and recovers`, async () => {
    let fail = true;
    const io = fixture({
      capacity: 1024,
      read: () => 0,
      write: (_offset, bytes) => bytes.length,
      writeZeroes() {
        if (!fail) return;
        if (asynchronous) return Promise.reject(new Error("zeroing failed"));
        throw new Error("zeroing failed");
      },
    });
    try {
      assert.equal(await io.request([{ bytes: range(0n, 1) }]), 1);
      fail = false;
      assert.equal(await io.request([{ bytes: range(1n, 1) }]), 0);
    } finally {
      await io.close();
    }
  });
}

for (const rejects of [false, true]) {
  test(`WRITE_ZEROES drains on close without completing stopped chains, backend rejects=${rejects}`, async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const io = fixture({
      capacity: 1024,
      read: () => 0,
      write: (_offset, bytes) => bytes.length,
      async writeZeroes() {
        events.push("entered");
        entered.resolve();
        await finish.promise;
        events.push("settled");
        if (rejects) throw new Error("stopped zeroing");
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
      io.queue([{ bytes: range(0n, 1) }]);
      io.queue([{ bytes: range(1n, 1) }], 1, 3);
      io.imports.enable_vring(0, 0, 16, 0, 1);
      io.imports.notify(0, 0);
      await entered.promise;
      closing = io.close();
      assert.deepEqual(events, ["entered", "stop"]);
      finish.resolve();
      await closing;
      assert.deepEqual(events, ["entered", "stop", "settled", "close"]);
      assert.equal(io.interrupts, 0);
      assert.equal(io.view.getUint8(4096), 255);
      assert.equal(io.view.getUint8(4097), 255);
    } finally {
      finish.resolve();
      await (closing ?? io.close());
    }
  });
}
