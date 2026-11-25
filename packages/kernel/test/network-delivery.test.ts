// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ethernetDevice, ethernetNetwork } from "../src/virtio/net.ts";
import { close_virtio_device, virtio_imports } from "../src/virtio/core.ts";

function receiveFixture() {
  const network = ethernetNetwork();
  const device = ethernetDevice(network, { macAddress: [2, 0, 0, 0, 0, 1] });
  const sender = network.addPort(() => assert.fail("sender must not receive its own frame"));
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const bytes = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  const errors: unknown[] = [];
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq() {},
    on_error(error) {
      errors.push(error);
    },
  });
  return {
    sender,
    bytes,
    view,
    errors,
    descriptor(index: number, address: number, length: number, next: boolean, writable = true) {
      view.setBigUint64(index * 16, BigInt(address), true);
      view.setUint32(index * 16 + 8, length, true);
      view.setUint16(index * 16 + 12, index + 10, true);
      view.setUint16(index * 16 + 14, 128 | (next ? 1 : 0) | (writable ? 2 : 0), true);
      bytes.fill(0x5a, address, address + length);
    },
    start(size: number) {
      imports.enable_vring(0, 0, size, 0, 1);
      imports.notify(0, 0);
    },
    async close() {
      sender.close();
      await close_virtio_device(device);
      network.close();
    },
  };
}

test("virtio-net drops an oversized RX frame without mutation and delivers the next scatter frame", async () => {
  const fixture = receiveFixture();
  fixture.descriptor(0, 256, 8, true);
  fixture.descriptor(1, 512, 16, false);
  fixture.descriptor(2, 768, 5, true);
  fixture.descriptor(3, 1024, 40, false);
  fixture.start(4);
  const header = [2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, 8, 0];
  try {
    await fixture.sender.send(Uint8Array.from([...header, ...Array(16).fill(0x91)]));
    assert.equal(fixture.view.getUint32(8, true), 0, "short chain completes with no written bytes");
    assert.equal(fixture.view.getUint16(12, true), 10);
    assert.equal(
      fixture.view.getUint16(14, true),
      (1 << 7) | (1 << 15),
      "short chain is returned on the used ring",
    );
    assert.deepEqual(fixture.bytes.subarray(256, 264), new Uint8Array(8).fill(0x5a));
    assert.deepEqual(fixture.bytes.subarray(512, 528), new Uint8Array(16).fill(0x5a));
    assert.deepEqual(fixture.bytes.subarray(768, 773), new Uint8Array(5).fill(0x5a));
    const next = Uint8Array.from([...header, 1, 2, 3, 4]);
    await fixture.sender.send(next);
    const packet = new Uint8Array(12 + next.byteLength);
    packet[10] = 1;
    packet.set(next, 12);
    assert.equal(fixture.view.getUint32(40, true), packet.byteLength);
    assert.equal(fixture.view.getUint16(44, true), 12);
    assert.equal(
      fixture.view.getUint16(46, true),
      (1 << 7) | (1 << 15) | 2,
      "next chain completes with writable used data",
    );
    assert.deepEqual(fixture.bytes.subarray(768, 773), packet.subarray(0, 5));
    assert.deepEqual(fixture.bytes.subarray(1024, 1049), packet.subarray(5));
    assert.deepEqual(fixture.bytes.subarray(1049, 1064), new Uint8Array(15).fill(0x5a));
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.close();
  }
});

test("virtio-net still rejects a nonwritable RX descriptor before copying packet bytes", async () => {
  const fixture = receiveFixture();
  fixture.descriptor(0, 256, 8, true);
  fixture.descriptor(1, 512, 40, false, false);
  fixture.start(2);
  try {
    await assert.rejects(
      fixture.sender.send(Uint8Array.from([2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2, 8, 0])),
      /virtio-net receive descriptor must be writable/,
    );
    assert.equal(fixture.view.getUint32(8, true), 8, "invalid chain is not completed");
    assert.equal(fixture.view.getUint16(14, true), 131);
    assert.deepEqual(fixture.bytes.subarray(256, 264), new Uint8Array(8).fill(0x5a));
    assert.deepEqual(fixture.bytes.subarray(512, 552), new Uint8Array(40).fill(0x5a));
  } finally {
    await fixture.close();
  }
});

test("Ethernet learning routes replies and forgets closed ports", async () => {
  const network = ethernetNetwork();
  const deliveries: string[] = [];
  const a = network.addPort(() => {
    deliveries.push("a");
  });
  const b = network.addPort(() => {
    deliveries.push("b");
  });
  network.addPort(() => {
    deliveries.push("observer");
  });
  const mac = (id: number) => [2, 0, 0, 0, 0, id];
  const frame = (source: number, destination?: number) =>
    Uint8Array.from([
      ...(destination === undefined ? [255, 255, 255, 255, 255, 255] : mac(destination)),
      ...mac(source),
      8,
      0,
    ]);
  try {
    await a.send(frame(1));
    assert.deepEqual(deliveries.splice(0), ["b", "observer"]);
    await b.send(frame(2, 1));
    assert.deepEqual(deliveries.splice(0), ["a"], "learned reply is not flooded");
    await a.send(frame(1, 2));
    assert.deepEqual(deliveries.splice(0), ["b"]);
    await a.send(frame(1, 1));
    assert.deepEqual(deliveries.splice(0), [], "same-port traffic is filtered");
    b.close();
    await a.send(frame(1, 2));
    assert.deepEqual(deliveries.splice(0), ["observer"], "closed destination becomes unknown");
    const replacement = network.addPort(() => {
      deliveries.push("replacement");
    });
    await replacement.send(frame(2, 1));
    assert.deepEqual(deliveries.splice(0), ["a"]);
    await a.send(frame(1, 2));
    assert.deepEqual(deliveries.splice(0), ["replacement"], "replacement address is learned");
  } finally {
    network.close();
  }
});

for (const asynchronous of [false, true]) {
  test(`broadcast continues after a receiver ${asynchronous ? "rejects" : "throws"}`, async () => {
    const network = ethernetNetwork();
    const release = Promise.withResolvers<void>();
    const failure = new Error("receiver failed");
    const received: Uint8Array[] = [];
    const sender = network.addPort(() => assert.fail("sender must not receive its own frame"));
    network.addPort((frame) => {
      frame.fill(0);
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    });
    network.addPort((frame) => {
      received.push(frame);
    });
    network.addPort(async (frame) => {
      await release.promise;
      received.push(frame);
    });
    const frame = Uint8Array.from([255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 0, 1, 8, 0]);
    let settled = false;
    const checked = assert
      .rejects(sender.send(frame), (error) => error === failure)
      .then(() => {
        settled = true;
      });
    try {
      await setImmediate();
      assert.equal(received.length, 1, "other ports receive despite the failed receiver");
      assert.deepEqual(received[0], frame, "receivers cannot corrupt another port's copy");
      assert.equal(settled, false, "send waits for outstanding delivery");
    } finally {
      release.resolve();
      await checked;
      network.close();
    }
    assert.equal(received.length, 2);
    assert.deepEqual(received[1], frame);
    assert.notEqual(received[0], received[1]);
  });
}
