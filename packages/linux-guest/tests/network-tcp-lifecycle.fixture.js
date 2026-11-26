// SPDX-License-Identifier: MIT
// Bundle this fixture with all @lowland/kernel imports resolved to src, so the
// adapter and transport share the same private device symbols. The root CI
// executes the resulting test bundle separately from packaged-kernel tests.
import assert from "node:assert/strict";
import test from "node:test";
import { getMachinePlugin } from "@lowland/kernel/plugin";
import { close_virtio_device, connect_virtio_device } from "../../kernel/src/virtio/core.ts";
import { guestAgent } from "../src/agent.ts";
import { createNetwork } from "../src/network.ts";

// Exercise the real Ethernet adapter through its packed transmit queue. No Linux
// boot or test-only network API is needed to create an outbound, lazy session.
async function tcpFixture({ guestInitiates = true } = {}) {
  const accepted = Promise.withResolvers();
  const handler = Promise.withResolvers();
  const network = createNetwork({
    connectTcp(session) {
      accepted.resolve(session);
      return handler.promise;
    },
    resolveDns() {
      assert.fail("TCP fixture must not resolve names");
    },
  });
  const attachment = network.attach(guestAgent());
  let device;
  attachment[getMachinePlugin]().configure({
    devices: {
      add(value) {
        device = value;
      },
    },
  });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  let completion;
  let received;
  const transport = connect_virtio_device(device, {
    memory,
    trigger_irq(irq) {
      (irq === 1 ? completion : received).resolve();
    },
    on_error(error) {
      completion?.reject(error);
      received?.reject(error);
    },
  });
  transport.enable_queue(1, 8, 0, 1);
  transport.enable_queue(0, 8, 256, 2);
  let slot = 0;
  let receiveSlot = 0;
  async function receive() {
    const ring = new DataView(memory.buffer);
    const descriptor = 256 + receiveSlot * 16;
    const address = 4096 + receiveSlot++ * 2048;
    ring.setBigUint64(descriptor, BigInt(address), true);
    ring.setUint32(descriptor + 8, 2048, true);
    ring.setUint16(descriptor + 14, 128 | 2, true);
    received = Promise.withResolvers();
    transport.notify(0);
    await received.promise;
    // Let emission finish updating the sender's sequence before replying.
    await new Promise((resolve) => setImmediate(resolve));
    return new DataView(
      memory.buffer.slice(address + 12, address + ring.getUint32(descriptor + 8, true)),
    );
  }
  async function send(flags, sequence = 100, acknowledgement = 0, window = 65535, port = 80) {
    const frame = new Uint8Array(12 + 14 + 20 + 20);
    const view = new DataView(frame.buffer);
    frame.set([2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2], 12);
    view.setUint16(24, 0x0800);
    const ip = 26;
    frame[ip] = 0x45;
    view.setUint16(ip + 2, 40);
    frame[ip + 8] = 64;
    frame[ip + 9] = 6;
    frame.set([192, 0, 2, 2, 192, 0, 2, 1], ip + 12);
    let sum = 0;
    for (let offset = ip; offset < ip + 20; offset += 2) sum += view.getUint16(offset);
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
    view.setUint16(ip + 10, ~sum & 0xffff);
    const tcp = ip + 20;
    view.setUint16(tcp, 12000);
    view.setUint16(tcp + 2, port);
    view.setUint32(tcp + 4, sequence);
    view.setUint32(tcp + 8, acknowledgement);
    frame[tcp + 12] = 0x50;
    frame[tcp + 13] = flags;
    view.setUint16(tcp + 14, window);
    sum = 6 + 20;
    for (let offset = ip + 12; offset < ip + 20; offset += 2) sum += view.getUint16(offset);
    for (let offset = tcp; offset < tcp + 20; offset += 2) sum += view.getUint16(offset);
    while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
    view.setUint16(tcp + 16, ~sum & 0xffff);
    const address = 1024 + slot * 128;
    new Uint8Array(memory.buffer, address, frame.length).set(frame);
    const ring = new DataView(memory.buffer);
    ring.setBigUint64(slot * 16, BigInt(address), true);
    ring.setUint32(slot * 16 + 8, frame.length, true);
    ring.setUint16(slot * 16 + 14, 128, true);
    slot++;
    completion = Promise.withResolvers();
    transport.notify(1);
    await completion.promise;
  }
  // SYN; acquiring a writer does not activate the handshake.
  if (guestInitiates) await send(2);
  const session = guestInitiates ? await accepted.promise : undefined;
  async function establish(writer) {
    const activate = writer.write(new Uint8Array());
    const synAck = await receive();
    assert.equal(synAck.getUint8(14 + 20 + 13), 2 | 16);
    const next = (synAck.getUint32(14 + 20 + 4) + 1) >>> 0;
    await send(16, 101, next);
    await activate;
    return next;
  }
  return {
    network,
    attachment,
    session,
    handler,
    send,
    receive,
    establish,
    detach() {
      return close_virtio_device(device);
    },
    async close() {
      network.close();
      handler.resolve();
      await close_virtio_device(device);
    },
  };
}

test(
  "host TCP connect recovers a dropped SYN and a dropped final ACK",
  { timeout: 4000 },
  async () => {
    const fixture = await tcpFixture({ guestInitiates: false });
    const tcp = 14 + 20;
    const connect = fixture.attachment.connect({ port: 12000 });
    void connect.catch(() => {});
    let writer;
    try {
      const lostSyn = await fixture.receive();
      assert.equal(lostSyn.getUint8(tcp + 13), 2);
      const retransmittedSyn = await fixture.receive();
      assert.equal(retransmittedSyn.getUint8(tcp + 13), 2);
      const initial = lostSyn.getUint32(tcp + 4);
      const port = lostSyn.getUint16(tcp);
      assert.equal(retransmittedSyn.getUint32(tcp + 4), initial);
      assert.equal(retransmittedSyn.getUint16(tcp), port);

      const next = (initial + 1) >>> 0;
      await fixture.send(2 | 16, 100, next, 65535, port);
      const lostAck = await fixture.receive();
      assert.equal(lostAck.getUint8(tcp + 13), 16);
      assert.equal(lostAck.getUint32(tcp + 4), next);
      assert.equal(lostAck.getUint32(tcp + 8), 101);
      writer = (await connect).writable.getWriter();

      await fixture.send(2 | 16, 200, next, 65535, port); // Different peer SYN sequence.
      await fixture.send(2 | 16, 100, (next + 1) >>> 0, 65535, port); // Different host ACK.
      await fixture.send(2 | 16, 100, next, 65535, port); // Exact repeat after the lost ACK.
      const repeatedAck = await fixture.receive();
      assert.equal(repeatedAck.getUint8(tcp + 13), 16);
      assert.equal(repeatedAck.getUint32(tcp + 4), next);
      assert.equal(repeatedAck.getUint32(tcp + 8), 101);

      const written = writer.write(Uint8Array.of(0xa5));
      void written.catch(() => {});
      const data = await fixture.receive(); // Earlier mismatches must not have queued replies.
      assert.equal(data.getUint8(tcp + 13), 16 | 8);
      assert.equal(data.getUint32(tcp + 4), next);
      assert.equal(data.getUint8(tcp + 20), 0xa5);
      await fixture.send(16, 101, (next + 1) >>> 0, 65535, port);
      await written;
    } finally {
      await fixture.close();
      writer?.releaseLock();
    }
  },
);

test(
  "guest TCP connect retries SYN-ACK after lazy activation until an exact final ACK",
  { timeout: 4000 },
  async () => {
    const fixture = await tcpFixture();
    const writer = fixture.session.writable.getWriter();
    const tcp = 14 + 20;
    try {
      let received = false;
      const firstFrame = fixture.receive().then((frame) => {
        received = true;
        return frame;
      });
      void firstFrame.catch(() => {});
      await fixture.send(2); // The guest repeats SYN while the host only holds a writer.
      assert.equal(received, false);
      const write = writer.write(Uint8Array.of(0x6b));
      void write.catch(() => {});
      const lostSynAck = await firstFrame;
      assert.equal(lostSynAck.getUint8(tcp + 13), 2 | 16);
      const initial = lostSynAck.getUint32(tcp + 4);
      const next = (initial + 1) >>> 0;
      const retriedSynAck = await fixture.receive();
      assert.equal(retriedSynAck.getUint8(tcp + 13), 2 | 16);
      assert.equal(retriedSynAck.getUint32(tcp + 4), initial);
      assert.equal(retriedSynAck.getUint32(tcp + 8), 101);
      await fixture.send(16, 102, next);
      await fixture.send(16, 101, (next + 1) >>> 0);
      const afterLostAck = await fixture.receive();
      assert.equal(afterLostAck.getUint8(tcp + 13), 2 | 16);
      assert.equal(afterLostAck.getUint32(tcp + 4), initial);
      assert.equal(afterLostAck.getUint32(tcp + 8), 101);

      await fixture.send(16, 101, next);
      const data = await fixture.receive();
      assert.equal(data.getUint8(tcp + 13), 16 | 8);
      assert.equal(data.getUint32(tcp + 4), next);
      assert.equal(data.getUint8(tcp + 20), 0x6b);
      await fixture.send(16, 101, (next + 1) >>> 0);
      await write;
    } finally {
      await fixture.close();
      writer.releaseLock();
    }
  },
);

for (const peerFirst of [false, true]) {
  test(
    `TCP graceful FIN preserves successful writer close (peer first: ${peerFirst})`,
    { timeout: 2000 },
    async () => {
      const fixture = await tcpFixture();
      const writer = fixture.session.writable.getWriter();
      const reader = fixture.session.readable.getReader();
      try {
        const next = await fixture.establish(writer);
        if (peerFirst) {
          await fixture.send(1 | 16, 101, next);
          await fixture.receive(); // ACK of the peer's FIN.
          assert.deepEqual(await reader.read(), { done: true, value: undefined });
        }
        const close = writer.close();
        const fin = await fixture.receive();
        assert.equal(fin.getUint8(14 + 20 + 13), 1 | 16);
        await fixture.send(16, peerFirst ? 102 : 101, (next + 1) >>> 0);
        await close;
        await writer.closed;
        if (!peerFirst) {
          // Local FIN only closes the write half. The read half remains usable.
          assert.equal(fixture.session.signal.aborted, false);
          await fixture.send(1 | 16, 101, (next + 1) >>> 0);
          assert.deepEqual(await reader.read(), { done: true, value: undefined });
        }
        await writer.closed;
        assert.equal(fixture.session.signal.aborted, true);
      } finally {
        await fixture.close();
        reader.releaseLock();
        writer.releaseLock();
      }
    },
  );
}

test(
  "established TCP retransmits dropped data and FIN with the same sequence",
  { timeout: 4000 },
  async () => {
    const fixture = await tcpFixture();
    const writer = fixture.session.writable.getWriter();
    const reader = fixture.session.readable.getReader();
    const tcp = 14 + 20;
    const sequence = (frame) => frame.getUint32(tcp + 4);
    const flags = (frame) => frame.getUint8(tcp + 13);
    const readPayload = (frame) =>
      new Uint8Array(frame.buffer, frame.byteOffset + tcp + 20, frame.byteLength - tcp - 20);
    try {
      const start = await fixture.establish(writer);
      const payload = Uint8Array.of(0x31, 0x72, 0xa5, 0x14);
      const write = writer.write(payload);
      void write.catch(() => {});
      const lostData = await fixture.receive();
      assert.equal(sequence(lostData), start);
      assert.equal(flags(lostData), 16 | 8);
      assert.deepEqual(readPayload(lostData), payload);

      const next = (start + payload.byteLength) >>> 0;
      await fixture.send(16, 101, (next + 1) >>> 0); // An ACK past the outstanding segment cannot complete it.
      await fixture.send(16, 101, start, 1); // A small updated window must not strand the existing segment.
      fixture.handler.resolve(); // Keep a concurrent handler FIN behind the unacknowledged data.
      const retriedData = await fixture.receive();
      assert.equal(sequence(retriedData), sequence(lostData));
      assert.equal(flags(retriedData), flags(lostData));
      assert.deepEqual(readPayload(retriedData), payload);
      await fixture.send(16, 101, next);
      await write;

      const closing = writer.close();
      void closing.catch(() => {});
      const lostFin = await fixture.receive();
      assert.equal(sequence(lostFin), next);
      assert.equal(flags(lostFin), 16 | 1);
      assert.equal(readPayload(lostFin).byteLength, 0);
      const retriedFin = await fixture.receive();
      assert.equal(sequence(retriedFin), sequence(lostFin));
      assert.equal(flags(retriedFin), flags(lostFin));
      assert.equal(readPayload(retriedFin).byteLength, 0);
      await fixture.send(16, 101, (next + 1) >>> 0);
      await closing;
      assert.equal(fixture.session.signal.aborted, false);
      await fixture.send(16 | 1, 101, (next + 1) >>> 0);
      assert.deepEqual(await reader.read(), { done: true, value: undefined });
      await writer.closed;
    } finally {
      await fixture.close();
      reader.releaseLock();
      writer.releaseLock();
    }
  },
);

for (const established of [false, true]) {
  for (const mode of [
    "network close",
    "device detach",
    "reader cancel",
    "peer reset",
    "handler rejection",
    ...(!established ? ["handler completion"] : []),
    "writer abort",
  ]) {
    test(
      `TCP ${mode} settles an idle writer (established: ${established})`,
      { timeout: 2000 },
      async () => {
        const fixture = await tcpFixture();
        const { network, session, handler } = fixture;
        const writer = session.writable.getWriter();
        const reason = new Error(`test ${mode}`);
        const closed = writer.closed.then(
          () => assert.fail("teardown must reject the idle writer"),
          (error) => error,
        );
        try {
          if (established) await fixture.establish(writer);
          if (mode === "network close") network.close();
          else if (mode === "device detach") await fixture.detach();
          else if (mode === "reader cancel") await session.readable.cancel(reason);
          else if (mode === "peer reset") await fixture.send(4);
          else if (mode === "handler rejection") handler.reject(reason);
          else if (mode === "handler completion") handler.resolve();
          else await writer.abort(reason);
          let timer;
          const error = await Promise.race([
            closed,
            new Promise((resolve) => {
              timer = setTimeout(() => resolve("pending"), 200);
            }),
          ]).finally(() => clearTimeout(timer));
          assert.notEqual(error, "pending", "idle writer.closed must settle after teardown");
          if (["reader cancel", "handler rejection", "writer abort"].includes(mode))
            assert.equal(error, reason);
          else assert.ok(error instanceof Error);
          assert.equal(session.signal.aborted, true);
        } finally {
          await fixture.close();
          writer.releaseLock();
        }
      },
    );
  }
}

test("TCP handler FIN completion also settles an idle writer", { timeout: 2000 }, async () => {
  const fixture = await tcpFixture();
  const writer = fixture.session.writable.getWriter();
  const reader = fixture.session.readable.getReader();
  const closed = assert.rejects(writer.closed, /TCP connection closed/);
  try {
    const next = await fixture.establish(writer);
    fixture.handler.resolve();
    const fin = await fixture.receive();
    assert.equal(fin.getUint8(14 + 20 + 13), 1 | 16);
    await fixture.send(1 | 16, 101, (next + 1) >>> 0);
    await closed;
    assert.deepEqual(await reader.read(), { done: true, value: undefined });
  } finally {
    await fixture.close();
    reader.releaseLock();
    writer.releaseLock();
  }
});

for (const stage of ["handshake", "data ACK", "FIN ACK"]) {
  test(`TCP network close rejects a writer waiting for ${stage}`, { timeout: 2000 }, async () => {
    const fixture = await tcpFixture();
    const writer = fixture.session.writable.getWriter();
    const closed = assert.rejects(writer.closed, /network closed/);
    try {
      if (stage !== "handshake") await fixture.establish(writer);
      const operation = stage === "FIN ACK" ? writer.close() : writer.write(new Uint8Array([42]));
      const rejected = assert.rejects(operation, /network closed/);
      await fixture.receive(); // Deliberately withhold the matching ACK.
      fixture.network.close();
      await rejected;
      await closed;
    } finally {
      await fixture.close();
      writer.releaseLock();
    }
  });
}

test("TCP writer abort cancels an unacknowledged segment", { timeout: 2000 }, async () => {
  const fixture = await tcpFixture();
  const writer = fixture.session.writable.getWriter();
  const reason = new Error("cancel pending TCP write");
  try {
    await fixture.establish(writer);
    const write = assert.rejects(writer.write(Uint8Array.of(42)), (error) => error === reason);
    await fixture.receive();
    await writer.abort(reason);
    await write;
    assert.equal(fixture.session.signal.reason, reason);
  } finally {
    await fixture.close();
    writer.releaseLock();
  }
});
