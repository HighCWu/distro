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

import { MemoryFs, serveNinep, type Fs } from "../src/virtio/ninep/host.ts";
import { setImmediate as tick } from "node:timers/promises";

function inodeAndLinks(bytes: Buffer) {
  return { ino: bytes.readBigUInt64LE(13), nlink: bytes.readBigUInt64LE(33) };
}

function u16(value: number) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}
function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
function u64(value: number | bigint) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt.asUintN(64, BigInt(value)));
  return bytes;
}
function string(value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([u16(bytes.length), bytes]);
}
function frame(type: number, tag: number, parts: readonly Uint8Array[] = []) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 7), Buffer.from([type]), u16(tag), body]);
}

async function client(fs: Fs, options: { readOnly?: boolean; timeout?: number } = {}) {
  const h = harness();
  const logs: string[] = [],
    connections: boolean[] = [];
  const server = serveNinep(h.device, { port: 9000, log: (message) => logs.push(message) });
  const exported = server.add(fs, options);
  exported.onConnection = (connected) => connections.push(connected);
  await h.send({ source: 1000, destination: 9000, op: REQUEST });
  assert.equal((await h.receive()).op, RESPONSE);
  let nextTag = 1,
    receivedBytes = 0;
  const send = async (bytes: Uint8Array, credit = 256 * 1024, forwarded = 0) =>
    h.send({ source: 1000, destination: 9000, op: RW, payload: [...bytes], credit, forwarded });
  async function reply() {
    let bytes = Buffer.alloc(0);
    while (bytes.length < 7 || bytes.length < bytes.readUInt32LE(0)) {
      const packet = await h.receive();
      if (packet.op === CREDIT_UPDATE) continue;
      assert.equal(packet.op, RW);
      receivedBytes += packet.payload.length;
      bytes = Buffer.concat([bytes, Buffer.from(packet.payload)]);
    }
    assert.equal(bytes.length, bytes.readUInt32LE(0));
    return { type: bytes[4]!, tag: bytes.readUInt16LE(5), bytes: bytes.subarray(7) };
  }
  async function query(type: number, parts: readonly Uint8Array[], expected = type + 1) {
    const tag = type === 100 ? 65535 : nextTag++;
    await send(frame(type, tag, parts));
    const result = await reply();
    assert.equal(result.type, expected);
    assert.equal(result.tag, tag);
    return result.bytes;
  }
  const version = await query(100, [u32(4096), string("9P2000.L")]);
  assert.equal(version.readUInt32LE(), 4096);
  assert.equal(version.subarray(6).toString(), "9P2000.L");
  await query(104, [u32(1), u32(0xffffffff), string(""), string(exported.name), u32(0)]);
  assert.equal(exported.connected, true);
  async function open(write = false) {
    const walked = await query(110, [u32(1), u32(2), u16(1), string("message.txt")]);
    assert.equal(walked.readUInt16LE(), 1);
    await query(12, [u32(2), u32(write ? 2 : 0)]);
  }
  async function stall() {
    await h.send({
      source: 1000,
      destination: 9000,
      op: CREDIT_UPDATE,
      credit: 0,
      forwarded: receivedBytes,
    });
  }
  async function close() {
    server.close();
    assert.equal(exported.connected, false);
    assert.equal((await h.receive()).op, RST);
    await tick();
    h.device.close();
    await h.device.closed;
  }
  return {
    ...h,
    packet: h.send,
    server,
    exported,
    logs,
    connections,
    send,
    query,
    reply,
    open,
    stall,
    close,
  };
}

test(
  "9P2000.L serves exact MemoryFs reads, writes, EOF, clunk and disconnect",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs();
    fs.writeFile("/message.txt", "known bytes\n");
    const c = await client(fs);
    await c.open(true);
    const read = await c.query(116, [u32(2), u64(0), u32(128)]);
    assert.equal(read.readUInt32LE(), 12);
    assert.equal(read.subarray(4).toString(), "known bytes\n");
    const changed = Buffer.from("saved bytes\n");
    const written = await c.query(118, [u32(2), u64(0), u32(changed.length), changed]);
    assert.equal(written.readUInt32LE(), changed.length);
    const overflow = await c.query(
      118,
      [u32(2), u64((1n << 53n) + 1n), u32(1), changed.subarray(0, 1)],
      7,
    );
    assert.equal(overflow.readUInt32LE(), 75);
    const reread = await c.query(116, [u32(2), u64(0), u32(128)]);
    assert.deepEqual(reread.subarray(4), changed);
    assert.deepEqual(fs.readFile("/message.txt"), new Uint8Array(changed));
    assert.equal((await c.query(116, [u32(2), u64(1000), u32(128)])).readUInt32LE(), 0);
    assert.equal(c.exported.connected, true, "file EOF does not close the transport");
    await c.query(120, [u32(2)]);
    await c.query(120, [u32(1)]);
    await c.packet({ source: 1000, destination: 9000, op: SHUTDOWN, flags: SHUTDOWN_SEND });
    assert.equal((await c.receive()).op, SHUTDOWN);
    await tick();
    assert.equal(c.exported.connected, false);
    await c.packet({ source: 1000, destination: 9000, op: RST });
    c.server.close();
    c.device.close();
    await c.device.closed;
    assert.deepEqual(c.connections, [true, false]);
    assert.throws(() => c.server.add(fs), /closed/);
    assert.deepEqual(c.logs, []);
  },
);

test(
  "stalled reply credit cannot release request slots or grow a reply queue",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "bounded output" });
    const originalOpen = fs.open.bind(fs);
    let reads = 0,
      closes = 0;
    fs.open = (path, flags) => {
      const file = originalOpen(path, flags);
      return {
        ...file,
        read(offset, length) {
          reads++;
          return file.read(offset, length);
        },
        close() {
          closes++;
          return file.close?.();
        },
      };
    };
    const c = await client(fs);
    await c.open();
    await c.stall();
    const requests = Buffer.concat(
      Array.from({ length: 33 }, (_, index) => frame(116, 100 + index, [u32(2), u64(0), u32(16)])),
    );
    await c.send(requests, 0);
    await tick();
    assert.equal(reads, 16, "only the fixed active window reached the backend");
    assert.equal(c.exported.connected, true, "normal overload applies transport backpressure");
    await c.close();
    assert.equal(closes, 1);
    assert.equal(c.exported.connected, false);
    assert.deepEqual(c.connections, [true, false]);
    assert.deepEqual(c.logs, []);
  },
);

test(
  "fast pre-attach responses have a bounded stalled-output window",
  { timeout: 3000 },
  async () => {
    const h = harness(),
      logs: string[] = [];
    const server = serveNinep(h.device, { port: 9000, log: (message) => logs.push(message) });
    await h.send({ source: 1000, destination: 9000, op: REQUEST, credit: 0 });
    assert.equal((await h.receive()).op, RESPONSE);
    const requests = Buffer.concat(Array.from({ length: 17 }, (_, tag) => frame(102, tag)));
    await h.send({ source: 1000, destination: 9000, op: RW, credit: 0, payload: [...requests] });
    assert.equal((await h.receive()).op, RST);
    await tick();
    assert.ok(logs.some((message) => /control response window/.test(message)));
    server.close();
    h.device.close();
    await h.device.closed;
  },
);

test(
  "Tflush suppresses late replies without freeing an unsettled handler slot",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "flush content" });
    const gate = Promise.withResolvers<void>();
    const originalOpen = fs.open.bind(fs);
    let reads = 0;
    fs.open = (path, flags) => {
      const file = originalOpen(path, flags);
      return {
        ...file,
        async read(offset, length) {
          reads++;
          await gate.promise;
          return file.read(offset, length);
        },
      };
    };
    const c = await client(fs, { timeout: 0 });
    await c.open();
    await c.send(
      Buffer.concat(
        Array.from({ length: 16 }, (_, index) =>
          frame(116, 100 + index, [u32(2), u64(0), u32(16)]),
        ),
      ),
    );
    await tick();
    assert.equal(reads, 16);
    await c.send(frame(108, 200, [u16(100)]));
    const flush = await c.reply();
    assert.equal(flush.type, 109);
    assert.equal(flush.tag, 200);
    await c.send(frame(116, 100, [u32(2), u64(0), u32(16)]));
    await tick();
    assert.equal(reads, 16, "flushed backend retains its physical slot");
    gate.resolve();
    const tags: number[] = [];
    for (let index = 0; index < 16; index++) {
      const result = await c.reply();
      assert.equal(result.type, 117);
      tags.push(result.tag);
    }
    assert.equal(
      tags.filter((tag) => tag === 100).length,
      1,
      "only the new reused tag receives a reply",
    );
    assert.equal(reads, 17);
    await c.close();
  },
);

test(
  "flushed tag remains reserved until its credit-blocked Rflush is sent",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "flush ownership" });
    const gate = Promise.withResolvers<void>();
    const originalOpen = fs.open.bind(fs);
    fs.open = (path, flags) => {
      const file = originalOpen(path, flags);
      return {
        ...file,
        async read(offset, length) {
          await gate.promise;
          return file.read(offset, length);
        },
      };
    };
    const c = await client(fs, { timeout: 0 });
    await c.open();
    await c.send(frame(116, 100, [u32(2), u64(0), u32(16)]));
    await c.stall();
    await c.send(frame(108, 200, [u16(100)]), 0);
    gate.resolve();
    await tick();
    // The old backend has now finished, but Rflush has no peer credit. Reusing
    // its tag before acknowledging Rflush remains a protocol violation.
    await c.send(frame(116, 100, [u32(2), u64(0), u32(16)]), 0);
    assert.equal((await c.receive()).op, RST);
    await tick();
    assert.equal(c.exported.connected, false);
    c.server.close();
    c.device.close();
    await c.device.closed;
  },
);

test(
  "hard links preserve inode, bytes, open files and same-inode rename paths",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "known bytes\n" });
    const initial = fs.getattr("/message.txt");
    const c = await client(fs);
    await c.open(true);
    const original = inodeAndLinks(await c.query(24, [u32(2), u64(0x7ff)]));
    assert.deepEqual(original, { ino: BigInt(initial.ino!), nlink: 1n });
    await c.query(70, [u32(1), u32(2), string("alias.txt")]);
    await c.query(110, [u32(1), u32(3), u16(1), string("alias.txt")]);
    const alias = inodeAndLinks(await c.query(24, [u32(3), u64(0x7ff)]));
    assert.deepEqual(alias, { ino: original.ino, nlink: 2n });
    assert.equal(fs.getattr("/message.txt").nlink, 2);
    const changedTime = fs.getattr("/message.txt").ctime!;
    assert.ok(
      changedTime.seconds > initial.ctime!.seconds ||
        (changedTime.seconds === initial.ctime!.seconds &&
          changedTime.nanoseconds >= initial.ctime!.nanoseconds),
    );
    await c.query(12, [u32(3), u32(2)]);
    const changed = Buffer.from("alias bytes\n");
    await c.query(118, [u32(3), u64(0), u32(changed.length), changed]);
    assert.deepEqual((await c.query(116, [u32(2), u64(0), u32(128)])).subarray(4), changed);
    assert.deepEqual(fs.readFile("/message.txt"), new Uint8Array(changed));
    // Keep an unopened source fid: rewriting its path after a same-inode
    // rename would incorrectly make it follow the alias that is removed next.
    await c.query(110, [u32(1), u32(4), u16(1), string("message.txt")]);
    await c.query(74, [u32(1), string("message.txt"), u32(1), string("alias.txt")]);
    assert.equal(fs.getattr("/message.txt").nlink, 2);
    assert.equal(fs.getattr("/alias.txt").nlink, 2);
    await c.query(76, [u32(1), string("alias.txt"), u32(0)]);
    assert.deepEqual(
      inodeAndLinks(await c.query(24, [u32(4), u64(0x7ff)])),
      { ino: original.ino, nlink: 1n },
      "same-inode rename did not rewrite the original fid path",
    );
    assert.deepEqual(
      (await c.query(116, [u32(3), u64(0), u32(128)])).subarray(4),
      changed,
      "unlinked alias remains readable through its open file",
    );
    await c.query(76, [u32(1), string("message.txt"), u32(0)]);
    assert.deepEqual(inodeAndLinks(await c.query(24, [u32(2), u64(0x7ff)])), {
      ino: original.ino,
      nlink: 0n,
    });
    assert.deepEqual((await c.query(116, [u32(2), u64(0), u32(128)])).subarray(4), changed);
    fs.writeFile("/message.txt", "replacement\n");
    assert.notEqual(BigInt(fs.getattr("/message.txt").ino!), original.ino);
    for (const stale of [2, 4]) {
      const error = await c.query(70, [u32(1), u32(stale), string("wrong-alias.txt")], 7);
      assert.equal(
        error.readUInt32LE(),
        116,
        "stale walk/open source identity must not link a replacement",
      );
    }
    assert.throws(() => fs.getattr("/wrong-alias.txt"), { code: "ENOENT" });
    const staleOpen = await c.query(12, [u32(4), u32(0)], 7);
    assert.equal(staleOpen.readUInt32LE(), 116);
    await c.query(110, [u32(1), u32(5), u16(0)]);
    await c.query(14, [u32(5), string("created.txt"), u32(2), u32(0o600), u32(0)]);
    await c.query(70, [u32(1), u32(5), string("created-alias.txt")]);
    assert.equal(fs.getattr("/created.txt").nlink, 2);
    assert.equal(fs.getattr("/created.txt").ino, fs.getattr("/created-alias.txt").ino);
    assert.equal(
      (await c.query(70, [u32(1), u32(5), string("created-alias.txt")], 7)).readUInt32LE(),
      17,
    );
    assert.equal(fs.getattr("/created.txt").nlink, 2, "EEXIST leaves link count unchanged");
    assert.equal(
      (await c.query(70, [u32(1), u32(1), string("directory-link")], 7)).readUInt32LE(),
      1,
    );
    fs.mkdirp("/destination");
    await c.query(110, [u32(1), u32(6), u16(1), string("destination")]);
    const oldDirectory = fs.getattr("/destination").ino;
    fs.move("/destination", "/old-destination");
    fs.mkdirp("/destination");
    assert.notEqual(fs.getattr("/destination").ino, oldDirectory);
    assert.equal(
      (await c.query(70, [u32(6), u32(5), string("wrong-directory-link")], 7)).readUInt32LE(),
      116,
      "a stale destination directory fid cannot link into its replacement",
    );
    assert.throws(() => fs.getattr("/destination/wrong-directory-link"), { code: "ENOENT" });
    assert.throws(() => fs.getattr("/old-destination/wrong-directory-link"), { code: "ENOENT" });
    await c.close();
    const ro = await client(fs, { readOnly: true });
    await ro.open();
    assert.equal(
      (await ro.query(70, [u32(1), u32(2), string("readonly-link")], 7)).readUInt32LE(),
      30,
    );
    assert.throws(() => fs.getattr("/readonly-link"), { code: "ENOENT" });
    await ro.close();
  },
);

test(
  "Tlopen cannot promote a path-only walk into hard-link authorization",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "identity", destination: {} });
    let fileStats = 0;
    const backend: Fs = {
      getattr(path) {
        const attr = fs.getattr(path);
        if ((path === "/message.txt" && fileStats++ === 0) || path === "/destination") {
          const { ino, dev, ...withoutIdentity } = attr;
          return withoutIdentity;
        }
        return attr;
      },
      readdir: fs.readdir.bind(fs),
      open: fs.open.bind(fs),
      link: fs.link.bind(fs),
    };
    const c = await client(backend);
    await c.open();
    assert.equal(
      (await c.query(70, [u32(1), u32(2), string("unauthorized")], 7)).readUInt32LE(),
      95,
      "the stable attributes returned by open do not authorize a path-only source fid",
    );
    await c.query(110, [u32(1), u32(3), u16(1), string("destination")]);
    await c.query(110, [u32(1), u32(4), u16(1), string("message.txt")]);
    assert.equal(
      (await c.query(70, [u32(3), u32(4), string("unauthorized-directory")], 7)).readUInt32LE(),
      116,
      "a directory without saved identity cannot authorize a link",
    );
    assert.throws(() => fs.getattr("/unauthorized"), { code: "ENOENT" });
    assert.throws(() => fs.getattr("/destination/unauthorized-directory"), { code: "ENOENT" });
    await c.close();
  },
);

test(
  "setattr/getattr preserve signed seconds and exact nanoseconds atomically",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "exact timestamps" });
    const c = await client(fs);
    await c.open(true);
    const times = (bytes: Buffer) => ({
      atime: { seconds: bytes.readBigInt64LE(73), nanoseconds: Number(bytes.readBigUInt64LE(81)) },
      mtime: { seconds: bytes.readBigInt64LE(89), nanoseconds: Number(bytes.readBigUInt64LE(97)) },
    });
    const set = (
      valid: number,
      atime: [bigint, bigint],
      mtime: [bigint, bigint],
      mode = 0o777,
      fid = 2,
    ) =>
      c.query(26, [
        u32(fid),
        u32(valid),
        u32(mode),
        u32(123),
        u32(456),
        u64(0xffffffffffffffffn),
        u64(atime[0]),
        u64(atime[1]),
        u64(mtime[0]),
        u64(mtime[1]),
      ]);
    await set(16 | 32 | 128 | 256, [-1n, 999999999n], [-123456789n, 123n]);
    const historical = times(await c.query(24, [u32(2), u64(0x7ff)]));
    assert.deepEqual(historical, {
      atime: { seconds: -1n, nanoseconds: 999999999 },
      mtime: { seconds: -123456789n, nanoseconds: 123 },
    });
    const currentSeconds = BigInt(Math.floor(Date.now() / 1000));
    const ignored: [bigint, bigint] = [0xffffffffffffffffn, 0xffffffffffffffffn];
    await set(32 | 256, ignored, [currentSeconds, 123456789n]);
    const current = times(await c.query(24, [u32(2), u64(0x7ff)]));
    assert.deepEqual(
      current.atime,
      historical.atime,
      "omitted atime does not use invalid wire fields",
    );
    assert.deepEqual(current.mtime, { seconds: currentSeconds, nanoseconds: 123456789 });
    assert.deepEqual(fs.getattr("/message.txt").mtime, current.mtime);
    assert.ok(Object.isFrozen(fs.getattr("/message.txt").mtime), "stored exact time is immutable");
    const beforeOmit = fs.getattr("/message.txt");
    await set(0, ignored, ignored);
    assert.deepEqual(
      fs.getattr("/message.txt"),
      beforeOmit,
      "all omitted fields cause no mutation",
    );
    await set(64, ignored, ignored);
    const { ctime, ...afterCtime } = fs.getattr("/message.txt");
    const { ctime: previousCtime, ...beforeCtime } = beforeOmit;
    assert.notStrictEqual(ctime, previousCtime, "the ctime-only request reached the backend");
    assert.deepEqual(afterCtime, beforeCtime);
    for (const [an, mn] of [
      [1000000000n, 123n],
      [123n, 1000000000n],
    ] as const) {
      const beforeInvalid = fs.getattr("/message.txt");
      const error = await c.query(
        26,
        [
          u32(2),
          u32(1 | 16 | 32 | 128 | 256),
          u32(0o777),
          u32(0),
          u32(0),
          u64(0),
          u64(-2n),
          u64(an),
          u64(3n),
          u64(mn),
        ],
        7,
      );
      assert.equal(error.readUInt32LE(), 22);
      assert.deepEqual(
        fs.getattr("/message.txt"),
        beforeInvalid,
        "invalid selected ns cannot partially change mode or either timestamp",
      );
    }
    const beforeNow = BigInt(Date.now()) * 1000000n;
    await set(16, ignored, ignored);
    const afterNow = BigInt(Date.now()) * 1000000n;
    const now = times(await c.query(24, [u32(2), u64(0x7ff)]));
    const atimeNs = now.atime.seconds * 1000000000n + BigInt(now.atime.nanoseconds);
    assert.ok(
      atimeNs >= beforeNow && atimeNs <= afterNow,
      "NOW ignores unselected explicit values",
    );
    assert.deepEqual(now.mtime, current.mtime, "NOW atime leaves omitted mtime exact");
    await c.query(70, [u32(1), u32(2), string("time-alias")]);
    await c.query(110, [u32(1), u32(3), u16(1), string("time-alias")]);
    await set(32 | 256, ignored, [-2n, 123456789n], 0, 3);
    const alias = times(await c.query(24, [u32(3), u64(0x7ff)]));
    const original = times(await c.query(24, [u32(2), u64(0x7ff)]));
    assert.deepEqual(alias, original, "hard links share the exact same inode timestamps");
    assert.deepEqual(original.mtime, { seconds: -2n, nanoseconds: 123456789 });
    await c.close();
  },
);

test(
  "user xattrs use bounded positional fids and atomic inode-checked clunk commits",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "xattr inode", directory: {} });
    const c = await client(fs);
    await c.open();
    let nextFid = 100;
    const begin = async (name: string, size: number, flags = 0, source = 2) => {
      const fid = nextFid++;
      await c.query(110, [u32(source), u32(fid), u16(0)]);
      await c.query(32, [u32(fid), string(name), u64(size), u32(flags)]);
      return fid;
    };
    const write = (fid: number, offset: number, value: string) => {
      const bytes = Buffer.from(value);
      return c.query(118, [u32(fid), u64(offset), u32(bytes.length), bytes]);
    };
    const clunk = (fid: number, expected = 121) => c.query(120, [u32(fid)], expected);
    const read = async (name: string, source = 2) => {
      const fid = nextFid++;
      const size = await c.query(30, [u32(source), u32(fid), string(name)]);
      const value = await c.query(116, [u32(fid), u64(0), u32(65536)]);
      assert.equal(BigInt(value.readUInt32LE()), size.readBigUInt64LE());
      await clunk(fid);
      return value.subarray(4);
    };
    const first = await begin("user.alpha", 6, 1);
    await write(first, 3, "def");
    await write(first, 0, "abc");
    assert.equal((await c.query(116, [u32(first), u64(0), u32(6)], 7)).readUInt32LE(), 9);
    await clunk(first);
    assert.equal((await read("user.alpha")).toString(), "abcdef");
    assert.equal((await read("")).toString(), "user.alpha\0");
    const exists = await begin("user.alpha", 1, 1);
    await write(exists, 0, "x");
    assert.equal((await clunk(exists, 7)).readUInt32LE(), 17);
    const missing = await begin("user.missing", 1, 2);
    await write(missing, 0, "x");
    assert.equal((await clunk(missing, 7)).readUInt32LE(), 61);
    assert.equal((await read("user.alpha")).toString(), "abcdef");
    const incomplete = await begin("user.partial", 6);
    await write(incomplete, 0, "abc");
    await write(incomplete, 0, "abc");
    assert.equal(
      (await clunk(incomplete, 7)).readUInt32LE(),
      22,
      "overlapping writes cannot pretend to cover the remaining bytes",
    );
    assert.equal(
      (await c.query(30, [u32(2), u32(nextFid++), string("user.partial")], 7)).readUInt32LE(),
      61,
    );
    await c.query(70, [u32(1), u32(2), string("alias")]);
    await c.query(110, [u32(1), u32(3), u16(1), string("alias")]);
    assert.equal((await read("user.alpha", 3)).toString(), "abcdef");
    const replace = await begin("user.alpha", 3, 2, 3);
    await write(replace, 0, "new");
    await clunk(replace);
    assert.equal((await read("user.alpha")).toString(), "new", "hard links share inode attributes");
    const removal = await begin("user.alpha", 0);
    await clunk(removal);
    assert.equal(
      (await c.query(30, [u32(3), u32(nextFid++), string("user.alpha")], 7)).readUInt32LE(),
      61,
    );
    assert.equal((await read("")).length, 0);
    const missingRemoval = await begin("user.alpha", 0);
    assert.equal((await clunk(missingRemoval, 7)).readUInt32LE(), 61);
    assert.equal(
      (await c.query(30, [u32(2), u32(nextFid++), string("security.label")], 7)).readUInt32LE(),
      95,
    );
    await c.query(110, [u32(1), u32(4), u16(1), string("directory")]);
    const directory = await begin("user.dir", 3, 0, 4);
    await write(directory, 0, "dir");
    await clunk(directory);
    assert.equal((await read("user.dir", 4)).toString(), "dir");
    const overflow = nextFid++;
    await c.query(110, [u32(2), u32(overflow), u16(0)]);
    assert.equal(
      (
        await c.query(32, [u32(overflow), string("user.large"), u64(65537), u32(0)], 7)
      ).readUInt32LE(),
      7,
    );
    const large = await begin("user.large", 65536);
    const pattern = Buffer.from(Uint8Array.from({ length: 65536 }, (_, index) => index % 251));
    for (let offset = 0; offset < pattern.length; offset += 1024) {
      const part = pattern.subarray(offset, offset + 1024);
      await c.query(118, [u32(large), u64(offset), u32(part.length), part]);
    }
    await clunk(large);
    const largeRead = nextFid++;
    assert.equal(
      (await c.query(30, [u32(2), u32(largeRead), string("user.large")])).readBigUInt64LE(),
      65536n,
    );
    for (let offset = 0; offset < pattern.length; offset += 1024) {
      const bytes = await c.query(116, [u32(largeRead), u64(offset), u32(1024)]);
      assert.deepEqual(bytes.subarray(4), pattern.subarray(offset, offset + 1024));
    }
    await clunk(largeRead);
    const stale = await begin("user.stale", 3);
    await write(stale, 0, "old");
    const oldIdentity = { ino: fs.getattr("/message.txt").ino! };
    fs.move("/message.txt", "/old-message");
    fs.writeFile("/message.txt", "replacement");
    assert.equal((await clunk(stale, 7)).readUInt32LE(), 116);
    const replacementIdentity = { ino: fs.getattr("/message.txt").ino! };
    assert.throws(() => fs.getxattr("/message.txt", "user.stale", replacementIdentity), {
      code: "ENODATA",
    });
    assert.throws(() => fs.getxattr("/old-message", "user.stale", oldIdentity), {
      code: "ENODATA",
    });
    await c.query(110, [u32(1), u32(5), u16(1), string("message.txt")]);
    const abandoned = await begin("user.abandoned", 3, 0, 5);
    await write(abandoned, 0, "new");
    await c.close();
    assert.throws(() => fs.getxattr("/message.txt", "user.abandoned", replacementIdentity), {
      code: "ENODATA",
    });
    const ro = await client(fs, { readOnly: true });
    await ro.open();
    await ro.query(110, [u32(2), u32(100), u16(0)]);
    assert.equal(
      (await ro.query(32, [u32(100), string("user.denied"), u64(1), u32(0)], 7)).readUInt32LE(),
      30,
    );
    await ro.close();
  },
);

test(
  "xattr snapshot fids have a fixed session allocation limit and release on clunk",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "bounded xattrs" });
    fs.setxattr("/message.txt", "user.value", Uint8Array.of(7), 0, {
      ino: fs.getattr("/message.txt").ino!,
    });
    const c = await client(fs);
    await c.open();
    for (let index = 0; index < 16; index++)
      await c.query(30, [u32(2), u32(100 + index), string("user.value")]);
    assert.equal(
      (await c.query(30, [u32(2), u32(200), string("user.value")], 7)).readUInt32LE(),
      23,
    );
    await c.query(120, [u32(100)]);
    await c.query(30, [u32(2), u32(200), string("user.value")]);
    await c.close();
  },
);

test(
  "renegotiating version abandons a pending xattr clunk instead of committing it",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "abandoned clunk" });
    const c = await client(fs);
    await c.open();
    await c.query(110, [u32(2), u32(100), u16(0)]);
    await c.query(32, [u32(100), string("user.cancelled"), u64(3), u32(0)]);
    await c.query(118, [u32(100), u64(0), u32(3), Buffer.from("new")]);
    await c.send(
      Buffer.concat([
        frame(120, 500, [u32(100)]),
        frame(100, 65535, [u32(4096), string("9P2000.L")]),
      ]),
    );
    const reply = await c.reply();
    assert.equal(reply.type, 101);
    assert.equal(reply.tag, 65535);
    assert.throws(
      () => fs.getxattr("/message.txt", "user.cancelled", { ino: fs.getattr("/message.txt").ino! }),
      { code: "ENODATA" },
    );
    await c.close();
  },
);

test(
  "walked fids atomically reject replacement truncation and path setattr",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({ "message.txt": "original inode contents" });
    const originalOpen = fs.open.bind(fs),
      originalSetattr = fs.setattr.bind(fs);
    let replaceOnOpen = false,
      replaceOnSetattr = false;
    fs.open = (path, flags) => {
      if (replaceOnOpen) {
        replaceOnOpen = false;
        fs.move(path, "/pre-open-original");
        fs.writeFile(path, "replacement must not truncate");
      }
      return originalOpen(path, flags);
    };
    fs.setattr = (path, attr, expected) => {
      if (replaceOnSetattr) {
        replaceOnSetattr = false;
        fs.move(path, "/pre-setattr-original");
        fs.writeFile(path, "setattr replacement intact");
      }
      return originalSetattr(path, attr, expected);
    };
    const c = await client(fs);
    await c.query(110, [u32(1), u32(2), u16(1), string("message.txt")]);
    replaceOnOpen = true;
    assert.equal((await c.query(12, [u32(2), u32(2 | 0o1000)], 7)).readUInt32LE(), 116);
    assert.equal(
      Buffer.from(fs.readFile("/message.txt")).toString(),
      "replacement must not truncate",
    );
    assert.equal(
      Buffer.from(fs.readFile("/pre-open-original")).toString(),
      "original inode contents",
    );
    // A fresh fid to the current inode still supports ordinary O_TRUNC.
    await c.query(110, [u32(1), u32(3), u16(1), string("message.txt")]);
    await c.query(12, [u32(3), u32(2 | 0o1000)]);
    assert.equal(fs.readFile("/message.txt").length, 0);
    const payload = Buffer.from("open original data");
    await c.query(118, [u32(3), u64(0), u32(payload.length), payload]);
    const setattr = (fid: number, size: number, mode: number, expected = 27) =>
      c.query(
        26,
        [
          u32(fid),
          u32(1 | 8),
          u32(mode),
          u32(0),
          u32(0),
          u64(size),
          u64(0),
          u64(0),
          u64(0),
          u64(0),
        ],
        expected,
      );
    fs.move("/message.txt", "/open-retained");
    fs.writeFile("/message.txt", "new path inode");
    await setattr(3, 4, 0o600);
    assert.equal(Buffer.from(fs.readFile("/open-retained")).toString(), "open");
    assert.equal(fs.getattr("/open-retained").mode, 0o600);
    assert.equal(
      Buffer.from(fs.readFile("/message.txt")).toString(),
      "new path inode",
      "open-file handle setattr follows its retained inode after rename",
    );
    fs.rm("/open-retained");
    await setattr(3, 2, 0o640);
    assert.equal(
      (await c.query(116, [u32(3), u64(0), u32(64)])).subarray(4).toString(),
      "op",
      "open-file handle setattr remains valid after unlink",
    );
    await c.query(110, [u32(1), u32(4), u16(1), string("message.txt")]);
    replaceOnSetattr = true;
    assert.equal((await setattr(4, 0, 0, 7)).readUInt32LE(), 116);
    assert.equal(Buffer.from(fs.readFile("/message.txt")).toString(), "setattr replacement intact");
    assert.equal(fs.getattr("/message.txt").mode, 0o644);
    assert.equal(Buffer.from(fs.readFile("/pre-setattr-original")).toString(), "new path inode");
    await c.query(110, [u32(1), u32(5), u16(1), string("message.txt")]);
    await setattr(5, 4, 0o640);
    assert.equal(Buffer.from(fs.readFile("/message.txt")).toString(), "seta");
    assert.equal(fs.getattr("/message.txt").mode, 0o640);
    await c.close();
  },
);

test(
  "remove and rename reject stale inode and parent fids without touching replacements",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({
      "message.txt": "original",
      source: { child: "original child" },
      target: { entry: "original target" },
      good: {},
    });
    const c = await client(fs);
    const walk = (fid: number, name: string) =>
      c.query(110, [u32(1), u32(fid), u16(1), string(name)]);
    const text = (path: string) => Buffer.from(fs.readFile(path)).toString();
    await walk(2, "message.txt");
    fs.move("/message.txt", "/original-message");
    fs.writeFile("/message.txt", "replacement");
    assert.equal((await c.query(122, [u32(2)], 7)).readUInt32LE(), 116);
    assert.equal(text("/message.txt"), "replacement");
    assert.equal(text("/original-message"), "original");
    assert.equal(
      (await c.query(24, [u32(2), u64(0x7ff)], 7)).readUInt32LE(),
      9,
      "failed Tremove still clunks its fid",
    );
    await walk(3, "original-message");
    fs.move("/original-message", "/retained-original");
    fs.writeFile("/original-message", "rename replacement");
    assert.equal(
      (await c.query(20, [u32(3), u32(1), string("bad-rename")], 7)).readUInt32LE(),
      116,
    );
    assert.equal(text("/original-message"), "rename replacement");
    assert.throws(() => fs.getattr("/bad-rename"), { code: "ENOENT" });
    await walk(4, "original-message");
    await c.query(20, [u32(4), u32(1), string("renamed-success")]);
    assert.equal(text("/renamed-success"), "rename replacement");
    await c.query(122, [u32(4)]);
    assert.throws(() => fs.getattr("/renamed-success"), { code: "ENOENT" });
    assert.equal((await c.query(24, [u32(4), u64(0x7ff)], 7)).readUInt32LE(), 9);
    await walk(10, "source");
    await walk(11, "target");
    await walk(12, "good");
    fs.move("/source", "/original-source");
    fs.mkdirp("/source");
    fs.writeFile("/source/child", "replacement child");
    assert.equal((await c.query(76, [u32(10), string("child"), u32(0)], 7)).readUInt32LE(), 116);
    assert.equal(text("/source/child"), "replacement child");
    assert.equal(
      (
        await c.query(74, [u32(10), string("child"), u32(12), string("bad-source")], 7)
      ).readUInt32LE(),
      116,
    );
    assert.equal(
      (await c.query(74, [u32(10), string("child"), u32(10), string("child")], 7)).readUInt32LE(),
      116,
      "same-path requests must still validate their saved parent identity",
    );
    assert.throws(() => fs.getattr("/good/bad-source"), { code: "ENOENT" });
    await walk(13, "message.txt");
    fs.move("/target", "/original-target");
    fs.mkdirp("/target");
    fs.writeFile("/target/entry", "replacement target");
    assert.equal((await c.query(20, [u32(13), u32(11), string("entry")], 7)).readUInt32LE(), 116);
    assert.equal(text("/message.txt"), "replacement");
    assert.equal(text("/target/entry"), "replacement target");
    fs.writeFile("/good/current", "current source");
    assert.equal(
      (await c.query(74, [u32(12), string("current"), u32(11), string("entry")], 7)).readUInt32LE(),
      116,
    );
    assert.equal(text("/good/current"), "current source");
    assert.equal(text("/target/entry"), "replacement target");
    await walk(14, "source");
    await walk(15, "target");
    await c.query(74, [u32(14), string("child"), u32(15), string("moved")]);
    assert.equal(text("/target/moved"), "replacement child");
    await c.query(76, [u32(15), string("moved"), u32(0)]);
    assert.throws(() => fs.getattr("/target/moved"), { code: "ENOENT" });
    assert.equal(text("/original-source/child"), "original child");
    assert.equal(text("/original-target/entry"), "original target");
    assert.equal(text("/retained-original"), "original");
    await c.close();
  },
);

test(
  "lcreate honors Linux access modes without reopening a fresh inode",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs();
    const originalOpen = fs.open.bind(fs);
    const calls: Array<{ read: boolean; write: boolean; truncate: boolean }> = [];
    let replaceOnOpen = false;
    fs.open = (path, flags) => {
      calls.push({ read: flags.read, write: flags.write, truncate: flags.truncate });
      if (replaceOnOpen) {
        replaceOnOpen = false;
        fs.move(path, "/before-open-race");
        fs.writeFile(path, "replacement intact");
      }
      const file = originalOpen(path, flags);
      return flags.write ? file : { ...file, write: undefined };
    };
    const c = await client(fs);
    const clone = (fid: number) => c.query(110, [u32(1), u32(fid), u16(0)]);
    const create = (fid: number, name: string, flags: number, expected = 15) =>
      c.query(14, [u32(fid), string(name), u32(flags), u32(0o644), u32(0)], expected);
    const read = (fid: number, expected = 117) =>
      c.query(116, [u32(fid), u64(0), u32(64)], expected);
    const write = (fid: number, expected = 119) =>
      c.query(118, [u32(fid), u64(0), u32(1), Buffer.from("x")], expected);
    for (let mode = 0; mode < 4; mode++) {
      const readable = mode === 0 || mode === 2,
        writable = mode === 1 || mode === 2;
      const fid = 20 + mode,
        name = "fresh-" + mode;
      await clone(fid);
      const before = calls.length;
      await create(fid, name, mode);
      assert.equal(calls.length, before, "a fresh create retains its returned inode handle");
      const got = await read(fid, readable ? 117 : 7);
      assert.equal(got.readUInt32LE(), readable ? 0 : 9);
      const written = await write(fid, writable ? 119 : 7);
      assert.equal(written.readUInt32LE(), writable ? 1 : 9);
      // Metadata operations are not data-I/O rights: chmod through a read-only or
      // mode-3 fid is permitted when the export itself is writable.
      await c.query(26, [
        u32(fid),
        u32(1),
        u32(0o600),
        u32(0),
        u32(0),
        u64(0),
        u64(0),
        u64(0),
        u64(0),
        u64(0),
      ]);
      assert.equal(fs.getattr("/" + name).mode, 0o600);
      await c.query(120, [u32(fid)]);
      const existing = "existing-" + mode;
      fs.writeFile("/" + existing, "data");
      const existingFid = 30 + mode;
      await clone(existingFid);
      const beforeExisting = calls.length;
      await create(existingFid, existing, mode);
      assert.equal(calls.length, beforeExisting + 1);
      assert.deepEqual(calls.at(-1), { read: readable, write: writable, truncate: false });
      const existingRead = await read(existingFid, readable ? 117 : 7);
      if (readable) assert.equal(existingRead.subarray(4).toString(), "data");
      else assert.equal(existingRead.readUInt32LE(), 9);
      assert.equal((await write(existingFid, writable ? 119 : 7)).readUInt32LE(), writable ? 1 : 9);
      await c.query(120, [u32(existingFid)]);
    }
    fs.writeFile("/exclusive", "keep");
    await clone(40);
    const beforeExclusive = calls.length;
    assert.equal((await create(40, "exclusive", 0o200, 7)).readUInt32LE(), 17);
    assert.equal(calls.length, beforeExclusive, "O_EXCL never falls back to open");
    assert.equal(Buffer.from(fs.readFile("/exclusive")).toString(), "keep");
    fs.writeFile("/readonly-truncate", "truncate");
    await clone(41);
    await create(41, "readonly-truncate", 0o1000);
    assert.deepEqual(calls.at(-1), { read: true, write: false, truncate: true });
    assert.equal(fs.readFile("/readonly-truncate").length, 0);
    assert.equal((await write(41, 7)).readUInt32LE(), 9);
    fs.writeFile("/open-race", "old contents");
    await clone(42);
    replaceOnOpen = true;
    assert.equal((await create(42, "open-race", 0o1000, 7)).readUInt32LE(), 116);
    assert.equal(Buffer.from(fs.readFile("/open-race")).toString(), "replacement intact");
    assert.equal(Buffer.from(fs.readFile("/before-open-race")).toString(), "old contents");
    await c.close();
    const ro = await client(fs, { readOnly: true });
    await ro.query(110, [u32(1), u32(50), u16(0)]);
    assert.equal(
      (
        await ro.query(14, [u32(50), string("denied"), u32(0), u32(0o600), u32(0)], 7)
      ).readUInt32LE(),
      30,
    );
    assert.throws(() => fs.getattr("/denied"), { code: "ENOENT" });
    await ro.close();
  },
);

test(
  "create mkdir and symlink atomically preserve their walked parent directory",
  { timeout: 3000 },
  async () => {
    const fs = new MemoryFs({
      directory: { existing: "original child" },
      race: { existing: "must not truncate" },
      "type-race": { existing: "original type child" },
      "missing-race": { existing: "original missing child" },
    });
    const originalOpen = fs.open.bind(fs),
      originalGetattr = fs.getattr.bind(fs);
    let swapOnOpen = false,
      swapOnGetattr = "";
    fs.open = (path, flags) => {
      if (swapOnOpen) {
        swapOnOpen = false;
        const source = { ino: originalGetattr("/race/existing").ino! };
        fs.move("/race", "/race-before");
        fs.mkdirp("/race");
        fs.link("/race-before/existing", "/race/existing", {
          source,
          directory: { ino: originalGetattr("/race").ino! },
        });
      }
      return originalOpen(path, flags);
    };
    fs.getattr = (path) => {
      if (path === swapOnGetattr) {
        swapOnGetattr = "";
        const parent = path.slice(0, path.lastIndexOf("/"));
        fs.move(parent, parent + "-before");
        fs.mkdirp(parent);
        if (parent === "/type-race") fs.mkdirp(path);
      }
      return originalGetattr(path);
    };
    const c = await client(fs);
    const walk = (fid: number, path: string) =>
      c.query(110, [u32(1), u32(fid), u16(1), string(path)]);
    const create = (fid: number, name: string, flags = 0, expected = 15) =>
      c.query(14, [u32(fid), string(name), u32(flags), u32(0o640), u32(0)], expected);
    const oldParent = { ino: fs.getattr("/directory").ino! };
    await walk(2, "directory");
    fs.move("/directory", "/directory-before");
    fs.mkdirp("/directory");
    fs.writeFile("/directory/existing", "replacement child");
    assert.equal(
      (await c.query(72, [u32(2), string("existing"), u32(0o755), u32(0)], 7)).readUInt32LE(),
      116,
    );
    assert.equal(
      (await c.query(16, [u32(2), string("existing"), string("target"), u32(0)], 7)).readUInt32LE(),
      116,
    );
    assert.equal(
      (await create(2, "existing", 0o200, 7)).readUInt32LE(),
      116,
      "parent identity precedes O_EXCL/EEXIST",
    );
    assert.equal((await create(2, "new-file", 0, 7)).readUInt32LE(), 116);
    assert.equal(Buffer.from(fs.readFile("/directory/existing")).toString(), "replacement child");
    assert.throws(() => fs.getattr("/directory/new-file"), { code: "ENOENT" });
    assert.throws(() => fs.create("/directory/existing", 0o600, oldParent), { code: "ESTALE" });
    assert.throws(() => fs.mkdir("/directory/existing", 0o700, oldParent), { code: "ESTALE" });
    assert.throws(() => fs.symlink("/directory/existing", "target", oldParent), { code: "ESTALE" });
    const currentParent = { ino: fs.getattr("/directory").ino! };
    const alias = fs.create("/directory//./alias-file", 0o600, currentParent);
    alias.write!(0, Buffer.from("normalized"));
    fs.mkdir("/directory//./alias-dir", 0o700, currentParent);
    fs.symlink("/directory//./alias-link", "alias-file", currentParent);
    assert.equal(Buffer.from(fs.readFile("/directory/alias-file")).toString(), "normalized");
    assert.equal(fs.readlink("/directory/alias-link"), "alias-file");
    await walk(3, "directory");
    await c.query(72, [u32(3), string("new-dir"), u32(0o750), u32(0)]);
    await c.query(16, [u32(3), string("new-link"), string("existing"), u32(0)]);
    assert.equal(fs.getattr("/directory/new-dir").type, "dir");
    assert.equal(fs.readlink("/directory/new-link"), "existing");
    await c.query(110, [u32(3), u32(4), u16(0)]);
    await create(4, "new-file");
    assert.equal(fs.getattr("/directory/new-file").mode, 0o640);
    await c.query(110, [u32(3), u32(5), u16(0)]);
    await create(5, "existing");
    assert.equal(
      (await c.query(116, [u32(5), u64(0), u32(64)])).subarray(4).toString(),
      "replacement child",
    );
    await walk(10, "race");
    swapOnOpen = true;
    assert.equal(
      (await create(10, "existing", 0o1000, 7)).readUInt32LE(),
      116,
      "fallback checks parent even if replacement aliases the exact same target inode",
    );
    assert.equal(Buffer.from(fs.readFile("/race/existing")).toString(), "must not truncate");
    assert.equal(Buffer.from(fs.readFile("/race-before/existing")).toString(), "must not truncate");
    await walk(11, "type-race");
    swapOnGetattr = "/type-race/existing";
    assert.equal(
      (await create(11, "existing", 0, 7)).readUInt32LE(),
      116,
      "fallback parent identity is checked before replacement target type errors",
    );
    assert.equal(fs.getattr("/type-race/existing").type, "dir");
    await walk(12, "missing-race");
    swapOnGetattr = "/missing-race/existing";
    assert.equal(
      (await create(12, "existing", 0, 7)).readUInt32LE(),
      116,
      "fallback missing target does not hide replacement parent identity",
    );
    assert.throws(() => fs.getattr("/missing-race/existing"), { code: "ENOENT" });
    assert.equal(
      Buffer.from(fs.readFile("/missing-race-before/existing")).toString(),
      "original missing child",
    );
    await c.close();
  },
);
