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
async function tcpFixture() {
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
  async function send(flags, sequence = 100, acknowledgement = 0) {
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
    view.setUint16(tcp + 2, 80);
    view.setUint32(tcp + 4, sequence);
    view.setUint32(tcp + 8, acknowledgement);
    frame[tcp + 12] = 0x50;
    frame[tcp + 13] = flags;
    view.setUint16(tcp + 14, 65535);
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
  await send(2); // SYN; acquiring a writer does not activate the handshake.
  const session = await accepted.promise;
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
