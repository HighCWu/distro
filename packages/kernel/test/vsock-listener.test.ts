// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { virtio_imports } from "../src/virtio/core.ts";
import { vsockConnectionClosed, vsockConnectionReset, vsockDevice } from "../src/virtio/vsock.ts";

const REQUEST = 1;
const RESPONSE = 2;
const RST = 3;
const SHUTDOWN = 4;
const RW = 5;
const CREDIT_UPDATE = 6;
const CREDIT_REQUEST = 7;
const SHUTDOWN_RCV = 1;
const SHUTDOWN_SEND = 2;
const HEADER_SIZE = 44;
const GUEST_CID = 37n;
const HOST_CID = 2n;

interface GuestPacket {
  source: number;
  destination: number;
  op: number;
  flags?: number;
  credit?: number;
  forwarded?: number;
  payload?: number[];
  cid?: bigint;
}

function harness() {
  const device = vsockDevice({ guestCid: GUEST_CID });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const interrupts = new Map<number, () => void>();
  const imports = virtio_imports({
    memory,
    devices: [device],
    trigger_irq(irq) {
      const resolve = interrupts.get(irq);
      assert(resolve, `unexpected IRQ ${irq}`);
      interrupts.delete(irq);
      resolve();
    },
    on_error(error) {
      throw error;
    },
  });
  const view = new DataView(memory.buffer);
  const wrap = [true, true];

  function enable() {
    for (let queue = 0; queue < 2; queue++) {
      view.setUint16(queue * 16 + 14, 0, true);
      wrap[queue] = true;
      imports.enable_vring(0, queue, 1, queue * 16, queue + 1);
    }
  }
  enable();

  function post(queue: number, address: number, length: number, writable: boolean) {
    const descriptor = queue * 16;
    const irq = queue + 1;
    const { promise, resolve } = Promise.withResolvers<void>();
    assert(!interrupts.has(irq));
    interrupts.set(irq, resolve);
    view.setBigUint64(descriptor, BigInt(address), true);
    view.setUint32(descriptor + 8, length, true);
    view.setUint16(descriptor + 12, 0, true);
    view.setUint16(descriptor + 14, (wrap[queue] ? 1 << 7 : 1 << 15) | (writable ? 2 : 0), true);
    wrap[queue] = !wrap[queue];
    imports.notify(0, queue);
    return promise;
  }

  async function send({
    source,
    destination,
    op,
    flags = op === SHUTDOWN ? SHUTDOWN_RCV | SHUTDOWN_SEND : 0,
    credit = 256 * 1024,
    forwarded = 0,
    payload = [],
    cid = GUEST_CID,
  }: GuestPacket) {
    const address = 4096;
    view.setBigUint64(address, cid, true);
    view.setBigUint64(address + 8, HOST_CID, true);
    view.setUint32(address + 16, source, true);
    view.setUint32(address + 20, destination, true);
    view.setUint32(address + 24, payload.length, true);
    view.setUint16(address + 28, 1, true);
    view.setUint16(address + 30, op, true);
    view.setUint32(address + 32, flags, true);
    view.setUint32(address + 36, credit, true);
    view.setUint32(address + 40, forwarded, true);
    new Uint8Array(memory.buffer, address + HEADER_SIZE, payload.length).set(payload);
    await post(1, address, HEADER_SIZE + payload.length, false);
  }

  async function receive() {
    const address = 128;
    await post(0, address, 2048 + HEADER_SIZE, true);
    assert.equal(view.getBigUint64(address, true), HOST_CID);
    assert.equal(view.getBigUint64(address + 8, true), GUEST_CID);
    assert.equal(view.getUint16(address + 28, true), 1);
    const length = view.getUint32(address + 24, true);
    assert.equal(view.getUint32(8, true), HEADER_SIZE + length);
    return {
      source: view.getUint32(address + 16, true),
      destination: view.getUint32(address + 20, true),
      op: view.getUint16(address + 30, true),
      forwarded: view.getUint32(address + 40, true),
      payload: [...new Uint8Array(memory.buffer, address + HEADER_SIZE, length)],
    };
  }

  function reset() {
    assert.equal(interrupts.size, 0);
    imports.reset(0);
    enable();
  }

  return { device, send, receive, reset };
}

test(
  "the host listener routes simultaneous streams and honors each peer's credit",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    const listener = device.listen(9000);
    const first_accept = listener.accept();
    await assert.rejects(listener.accept(), /already pending/);
    await send({ source: 1000, destination: 9000, op: REQUEST, credit: 2 });
    const a = await first_accept;
    assert(a);
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: RESPONSE,
      forwarded: 0,
      payload: [],
    });

    // A request from a different CID must not collide with the established stream.
    await send({ source: 1000, destination: 9000, op: REQUEST, cid: 38n });
    await send({ source: 1001, destination: 9000, op: REQUEST, credit: 8 });
    const b = await listener.accept();
    assert(b);
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1001,
      op: RESPONSE,
      forwarded: 0,
      payload: [],
    });

    await send({ source: 1001, destination: 9000, op: RW, credit: 8, payload: [9] });
    await send({ source: 1000, destination: 9000, op: RW, credit: 2, payload: [1, 2, 3] });
    assert.deepEqual([...(await a.readExactly(2))], [1, 2]);
    assert.deepEqual([...(await b.read())], [9]);
    await send({ source: 1000, destination: 9000, op: CREDIT_REQUEST, credit: 2 });
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: CREDIT_UPDATE,
      forwarded: 2,
      payload: [],
    });
    assert.deepEqual([...(await a.read())], [3]);

    let done = false;
    const writing_a = a.write(Uint8Array.of(4, 5, 6)).then(() => {
      done = true;
    });
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: RW,
      forwarded: 3,
      payload: [4, 5],
    });
    const writing_b = b.write(Uint8Array.of(7));
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1001,
      op: RW,
      forwarded: 1,
      payload: [7],
    });
    await writing_b;
    assert.equal(done, false);
    await send({ source: 1001, destination: 9000, op: CREDIT_UPDATE, forwarded: 1, credit: 8 });
    assert.equal(done, false);
    await send({ source: 1000, destination: 9000, op: CREDIT_UPDATE, forwarded: 2, credit: 2 });
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: RW,
      forwarded: 3,
      payload: [6],
    });
    await writing_a;
    device.close();
    await device.closed;
  },
);

test(
  "host refusal, listener close and connection close affect the intended endpoints",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    await send({ source: 1000, destination: 9000, op: REQUEST });
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: RST,
      forwarded: 0,
      payload: [],
    });

    // Leave one refusal queued while the host starts listening. The next
    // accepted incarnation of this tuple must not inherit that old reset.
    await send({ source: 1000, destination: 9000, op: REQUEST });
    const listener = device.listen(9000);
    assert.throws(() => device.listen(9000), /in use/);
    await send({ source: 1000, destination: 9000, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    const a = await listener.accept();
    assert(a);
    await send({ source: 1001, destination: 9000, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    listener.close();
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1001,
      op: RST,
      forwarded: 0,
      payload: [],
    });
    assert.equal(await listener.accept(), null);

    await send({ source: 1000, destination: 9000, op: RW, payload: [8] });
    assert.deepEqual([...(await a.read())], [8]);
    const local_close = vsockConnectionClosed(a);
    a.close();
    await local_close;
    assert.equal((await receive()).op, SHUTDOWN);
    assert.throws(() => device.listen(9000), /in use/);
    await send({ source: 1000, destination: 9000, op: RST });

    const replacement = device.listen(9000);
    const pending = replacement.accept();
    device.close();
    await device.closed;
    assert.equal(await pending, null);
    assert.throws(() => device.listen(9001), /closed/);
  },
);

test(
  "peer reset settles the terminal observer without a pending read",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    const listener = device.listen(9000);
    const endpoint = { source: 1000, destination: 9000 };
    await send({ ...endpoint, op: REQUEST, credit: 0 });
    assert.equal((await receive()).op, RESPONSE);
    const stream = await listener.accept();
    assert(stream);
    assert.throws(() => vsockConnectionClosed({ ...stream }), /invalid vsock connection/);
    const closed = vsockConnectionClosed(stream);
    assert.equal(vsockConnectionClosed(stream), closed);

    const blocked = assert.rejects(stream.write(Uint8Array.of(7)), /closed/);
    await send({ ...endpoint, op: RW, credit: 0, payload: [1] });
    await send({ ...endpoint, op: RST, credit: 0 });
    await closed;
    await blocked;

    device.close();
    await device.closed;
  },
);

test(
  "device reset rejects stale sessions while listeners can accept after reprobe",
  { timeout: 3000 },
  async () => {
    const { device, send, receive, reset } = harness();
    const listener = device.listen(9000);
    await send({ source: 1000, destination: 9000, op: REQUEST, credit: 0 });
    assert.equal((await receive()).op, RESPONSE);
    const a = await listener.accept();
    assert(a);
    const pending_read = a.read();
    const blocked_write = assert.rejects(a.write(Uint8Array.of(7)), /closed/);
    await send({ source: 1001, destination: 9000, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    reset();
    assert.equal((await pending_read).byteLength, 0);
    await blocked_write;
    const after_reset = listener.accept();
    await send({ source: 1002, destination: 9000, op: REQUEST });
    assert.equal((await receive()).destination, 1002);
    const b = await after_reset;
    assert(b);
    await send({ source: 1002, destination: 9000, op: RW, payload: [9] });
    assert.deepEqual([...(await b.read())], [9]);
    device.close();
    await device.closed;
    assert.equal((await b.read()).byteLength, 0);
  },
);

test(
  "local reset drops queued data only for its stream and emits RST",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    const listener = device.listen(9000);
    const endpoint = { source: 1000, destination: 9000 };
    await send({ ...endpoint, op: REQUEST, credit: 2 });
    assert.equal((await receive()).op, RESPONSE);
    const stream = await listener.accept();
    assert(stream);
    await send({ ...endpoint, source: 1001, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    const other = await listener.accept();
    assert(other);

    const blocked = assert.rejects(stream.write(Uint8Array.of(1, 2, 3)), /closed/);
    await other.write(Uint8Array.of(4));
    await send({ ...endpoint, op: RW, credit: 2, payload: [5] });

    const closed = vsockConnectionClosed(stream);
    assert.throws(() => vsockConnectionReset({ ...stream }), /invalid vsock connection/);
    vsockConnectionReset(stream);
    vsockConnectionReset(stream);
    await closed;
    await blocked;
    assert.equal((await stream.read()).byteLength, 0);
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1001,
      op: RW,
      forwarded: 0,
      payload: [4],
    });
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: RST,
      forwarded: 0,
      payload: [],
    });

    await send({ ...endpoint, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    const replacement = await listener.accept();
    assert(replacement);
    vsockConnectionReset(stream);
    await replacement.write(Uint8Array.of(6));
    assert.deepEqual((await receive()).payload, [6]);
    await other.write(Uint8Array.of(7));
    assert.deepEqual((await receive()).payload, [7]);

    device.close();
    await device.closed;
  },
);

test("saturation preserves queued writes and closing packets", { timeout: 10_000 }, async () => {
  const { device, send, receive } = harness();
  const listener = device.listen(9000);
  await send({ source: 1000, destination: 9000, op: REQUEST, credit: 4 * 1024 * 1024 });
  assert.equal((await receive()).op, RESPONSE);
  const stream = await listener.accept();
  assert(stream);

  await send({ source: 1001, destination: 9000, op: REQUEST });
  assert.equal((await receive()).op, RESPONSE);

  // Flood unconnected ports without giving the transport another RX buffer.
  const refusal_count = 16;
  for (let i = 0; i < 1024; i++) {
    await send({ source: 2000 + i, destination: 9100, op: REQUEST });
  }
  // The refusal flood must leave room for all the data slots. Fill the
  // remaining ordinary control slots as well before closing either stream.
  const data_count = 960 - refusal_count;
  await stream.write(new Uint8Array(data_count * 2048).fill(0x5a));
  for (let i = 0; i < 64; i++) {
    await send({ source: 1000, destination: 9000, op: CREDIT_REQUEST });
  }

  stream.close();
  listener.close();
  assert.throws(() => device.listen(9000), /in use/);

  for (let i = 0; i < refusal_count; i++) {
    const packet = await receive();
    assert.equal(packet.op, RST);
    assert.equal(packet.destination, 2000 + i);
  }
  let written = 0;
  for (let i = 0; i < data_count; i++) {
    const packet = await receive();
    assert.equal(packet.op, RW);
    assert.equal(packet.destination, 1000);
    assert.equal(packet.payload.length, 2048);
    assert(packet.payload.every((byte) => byte === 0x5a));
    written += packet.payload.length;
  }
  assert.equal(written, data_count * 2048);
  for (let i = 0; i < 64; i++) {
    const packet = await receive();
    assert.equal(packet.op, CREDIT_UPDATE);
    assert.equal(packet.destination, 1000);
  }
  const shutdown = await receive();
  assert.equal(shutdown.op, SHUTDOWN);
  assert.equal(shutdown.destination, 1000);
  const listener_reset = await receive();
  assert.equal(listener_reset.op, RST);
  assert.equal(listener_reset.destination, 1001);
  await send({ source: 1000, destination: 9000, op: RST });
  device.listen(9000).close();
  device.close();
  await device.closed;
});

test("peer shutdown preserves bytes buffered before accept", { timeout: 3000 }, async () => {
  const { device, send, receive } = harness();
  const listener = device.listen(9000);
  await send({ source: 1000, destination: 9000, op: REQUEST });
  assert.equal((await receive()).op, RESPONSE);
  await send({ source: 1000, destination: 9000, op: RW, payload: [1, 2, 3] });
  await send({ source: 1000, destination: 9000, op: SHUTDOWN });
  assert.equal((await receive()).op, RST);

  const stream = await listener.accept();
  assert(stream);
  assert.deepEqual([...(await stream.read())], [1, 2, 3]);
  assert.equal((await stream.read()).byteLength, 0);
  device.close();
  await device.closed;
});

test(
  "peer send shutdown drains input to EOF and still receives a reply",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    const listener = device.listen(9000);
    const endpoint = { source: 1000, destination: 9000 };
    await send({ ...endpoint, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    const stream = await listener.accept();
    assert(stream);
    const closed = vsockConnectionClosed(stream);
    let terminal = false;
    void closed.then(() => {
      terminal = true;
    });

    await send({ ...endpoint, op: RW, payload: [0x51, 0, 0xff] });
    const request = stream.readExactly(4);
    await send({ ...endpoint, op: SHUTDOWN, flags: SHUTDOWN_SEND });
    assert.deepEqual([...(await request)], [0x51, 0, 0xff]);
    assert.equal(terminal, false);
    // Successive shutdown messages cannot reopen a completed direction.
    await send({ ...endpoint, op: SHUTDOWN, flags: 0 });
    assert.equal((await stream.read()).byteLength, 0);

    await stream.write(Uint8Array.of(0x13, 0xa5));
    assert.deepEqual(await receive(), {
      source: 9000,
      destination: 1000,
      op: RW,
      forwarded: 3,
      payload: [0x13, 0xa5],
    });
    await send({ ...endpoint, op: SHUTDOWN, forwarded: 2, flags: SHUTDOWN_RCV });
    await closed;
    assert.equal((await receive()).op, RST);
    listener.close();
    device.listen(9000).close();
    device.close();
    await device.closed;
  },
);

test(
  "concurrent reads consume split packets in invocation order before EOF",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    const listener = device.listen(9000);
    const endpoint = { source: 1000, destination: 9000 };
    await send({ ...endpoint, op: REQUEST });
    assert.equal((await receive()).op, RESPONSE);
    const stream = await listener.accept();
    assert(stream);

    const exact = stream.readExactly(4);
    const remainder = stream.read();
    const end = stream.readExactly(2);
    await send({ ...endpoint, op: RW, payload: [1, 2] });
    await send({ ...endpoint, op: RW, payload: [3, 4, 5] });
    await send({ ...endpoint, op: SHUTDOWN, flags: SHUTDOWN_SEND });
    assert.deepEqual([...(await exact)], [1, 2, 3, 4]);
    assert.deepEqual([...(await remainder)], [5]);
    assert.equal((await end).byteLength, 0);

    await send({ ...endpoint, op: CREDIT_REQUEST });
    const credit = await receive();
    assert.equal(credit.op, CREDIT_UPDATE);
    assert.equal(credit.forwarded, 5);
    device.close();
    await device.closed;
  },
);

test(
  "peer receive shutdown wakes blocked writers and leaves input open",
  { timeout: 3000 },
  async () => {
    const { device, send, receive } = harness();
    const listener = device.listen(9000);
    const endpoint = { source: 1000, destination: 9000 };
    await send({ ...endpoint, op: REQUEST, credit: 2 });
    assert.equal((await receive()).op, RESPONSE);
    const stream = await listener.accept();
    assert(stream);
    const closed = vsockConnectionClosed(stream);
    let terminal = false;
    void closed.then(() => {
      terminal = true;
    });

    const writing = assert.rejects(stream.write(Uint8Array.of(1, 2, 3)), /peer stopped receiving/);
    await Promise.resolve();
    await send({ ...endpoint, op: SHUTDOWN, credit: 2, flags: SHUTDOWN_RCV });
    await writing;
    assert.equal(terminal, false);
    await assert.rejects(stream.write(Uint8Array.of(4)), /peer stopped receiving/);

    await send({ ...endpoint, op: RW, payload: [0x61] });
    assert.deepEqual([...(await stream.read())], [0x61]);
    await send({ ...endpoint, op: CREDIT_REQUEST });
    // Discard the host payload still held in the RX queue before sending control.
    assert.equal((await receive()).op, CREDIT_UPDATE);
    const end = stream.read();
    await send({ ...endpoint, op: SHUTDOWN, flags: SHUTDOWN_SEND });
    await closed;
    assert.equal((await end).byteLength, 0);
    assert.equal((await receive()).op, RST);
    device.close();
    await device.closed;
  },
);

test("active host connect still handshakes and exchanges data", { timeout: 3000 }, async () => {
  const { device, send, receive } = harness();
  device.listen(49152);
  const pending = device.connect(9000);
  const request = await receive();
  assert.equal(request.op, REQUEST);
  assert.equal(request.destination, 9000);
  assert.notEqual(request.source, 49152, "active connect does not reuse a listening port");
  await send({ source: 9000, destination: request.source, op: RESPONSE });
  const connection = await pending;
  await send({ source: 9000, destination: request.source, op: RW, payload: [3] });
  assert.deepEqual([...(await connection.read())], [3]);
  const write = connection.write(Uint8Array.of(4, 5));
  assert.deepEqual(await receive(), {
    source: request.source,
    destination: 9000,
    op: RW,
    forwarded: 1,
    payload: [4, 5],
  });
  await write;
  device.close();
  await device.closed;
});
