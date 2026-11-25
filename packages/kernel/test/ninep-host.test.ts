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
  bytes.writeBigUInt64LE(BigInt(value));
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
    assert.ok(fs.getattr("/message.txt").ctimeMs! >= initial.ctimeMs!);
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
