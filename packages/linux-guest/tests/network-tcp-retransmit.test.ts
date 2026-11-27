// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { getMachinePlugin } from "@lowland/kernel/plugin";
// @ts-ignore Internal virtio test transport shares the compiled @lowland/kernel symbols.
import { close_virtio_device, connect_virtio_device } from "../../kernel/dist/virtio/core.js";
import { guestAgent } from "../src/agent.ts";
import { createNetwork, type TcpSession } from "../src/network.ts";

function ipv4Checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.byteLength; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
  }
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

function tcpChecksum(
  srcIp: readonly [number, number, number, number],
  dstIp: readonly [number, number, number, number],
  tcp: Uint8Array,
): number {
  const pseudo = new Uint8Array(12 + tcp.byteLength);
  pseudo.set(srcIp, 0);
  pseudo.set(dstIp, 4);
  pseudo[9] = 6;
  new DataView(pseudo.buffer).setUint16(10, tcp.byteLength);
  pseudo.set(tcp, 12);
  return ipv4Checksum(pseudo);
}

function buildTcpFrame(
  srcPort: number,
  dstPort: number,
  seq: number,
  ack: number,
  flags: number,
  window = 65535,
  payload = new Uint8Array(),
): Uint8Array {
  const tcpLength = 20 + payload.byteLength;
  const ipLength = 20 + tcpLength;
  const frame = new Uint8Array(12 + 14 + ipLength);
  const view = new DataView(frame.buffer);
  frame.set([2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2], 12);
  view.setUint16(24, 0x0800);
  const ip = 26;
  frame[ip] = 0x45;
  view.setUint16(ip + 2, ipLength);
  frame[ip + 8] = 64;
  frame[ip + 9] = 6;
  frame.set([192, 0, 2, 2, 192, 0, 2, 1], ip + 12);
  view.setUint16(ip + 10, ipv4Checksum(frame.subarray(ip, ip + 20)));
  const tcp = ip + 20;
  view.setUint16(tcp, srcPort);
  view.setUint16(tcp + 2, dstPort);
  view.setUint32(tcp + 4, seq);
  view.setUint32(tcp + 8, ack);
  frame[tcp + 12] = 0x50;
  frame[tcp + 13] = flags;
  view.setUint16(tcp + 14, window);
  frame.set(payload, tcp + 20);
  view.setUint16(
    tcp + 16,
    tcpChecksum([192, 0, 2, 2], [192, 0, 2, 1], frame.subarray(tcp, tcp + tcpLength)),
  );
  return frame;
}

function parseTcpFrame(frame: DataView) {
  assert.equal(frame.getUint16(12), 0x0800);
  const ip = 14;
  assert.equal(frame.getUint8(ip + 9), 6);
  const ihl = (frame.getUint8(ip) & 0x0f) * 4;
  const totalLength = frame.getUint16(ip + 2);
  const tcp = ip + ihl;
  const dataOffset = (frame.getUint8(tcp + 12) >>> 4) * 4;
  const seq = frame.getUint32(tcp + 4);
  const ack = frame.getUint32(tcp + 8);
  const flags = frame.getUint8(tcp + 13);
  const payload = new Uint8Array(
    frame.buffer,
    frame.byteOffset + tcp + dataOffset,
    totalLength - ihl - dataOffset,
  );
  return { seq, ack, flags, payload };
}

function createVirtioHarness(network: ReturnType<typeof createNetwork>) {
  const attachment = network.attach(guestAgent());
  let device: unknown;
  attachment[getMachinePlugin]().configure({
    args: { add() {} },
    devices: {
      add(value) {
        device = value;
      },
    },
    deviceTree: { merge() {} },
  });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  let completion: PromiseWithResolvers<void> | undefined;
  let received: PromiseWithResolvers<void> | undefined;
  const transport = connect_virtio_device(device as never, {
    memory,
    trigger_irq(irq: number) {
      (irq === 1 ? completion : received)?.resolve();
    },
    on_error(error: unknown) {
      completion?.reject(error);
      received?.reject(error);
    },
  });
  transport.enable_queue(1, 8, 0, 1);
  transport.enable_queue(0, 8, 256, 2);
  let txSlot = 0;
  let rxSlot = 0;

  async function sendFrame(frame: Uint8Array) {
    const ring = new DataView(memory.buffer);
    const descriptor = (txSlot % 8) * 16;
    const address = 16384 + (txSlot++ % 8) * 2048;
    new Uint8Array(memory.buffer, address, frame.byteLength).set(frame);
    ring.setBigUint64(descriptor, BigInt(address), true);
    ring.setUint32(descriptor + 8, frame.byteLength, true);
    ring.setUint16(descriptor + 14, 128, true);
    completion = Promise.withResolvers<void>();
    transport.notify(1);
    await completion.promise;
  }

  async function receiveFrame() {
    const ring = new DataView(memory.buffer);
    const descriptor = 256 + (rxSlot % 8) * 16;
    const address = 4096 + (rxSlot++ % 8) * 2048;
    ring.setBigUint64(descriptor, BigInt(address), true);
    ring.setUint32(descriptor + 8, 2048, true);
    ring.setUint16(descriptor + 14, 128 | 2, true);
    received = Promise.withResolvers<void>();
    transport.notify(0);
    await received.promise;
    await new Promise((resolve) => setImmediate(resolve));
    return new DataView(
      memory.buffer.slice(address + 12, address + ring.getUint32(descriptor + 8, true)),
    );
  }

  return {
    sendFrame,
    receiveFrame,
    async close() {
      await close_virtio_device(device as never);
    },
  };
}

test("outbound TCP retransmits dropped segment on RTO and fast-retransmits on 3 dup ACKs", async () => {
  const accepted = Promise.withResolvers<TcpSession>();
  const network = createNetwork({
    async connectTcp(session) {
      accepted.resolve(session);
      const writer = session.writable.getWriter();
      await writer.write(new TextEncoder().encode("hello-rto"));
      await writer.write(new TextEncoder().encode("fast-dup"));
      await writer.close();
      writer.releaseLock();
    },
    async resolveDns() {
      assert.fail("unexpected DNS");
    },
  });
  const harness = createVirtioHarness(network);
  try {
    // SYN
    await harness.sendFrame(buildTcpFrame(41000, 80, 100, 0, 0x02));
    await accepted.promise;
    const synAck = parseTcpFrame(await harness.receiveFrame());
    assert.equal(synAck.flags & 0x12, 0x12);
    const serverSeq = (synAck.seq + 1) >>> 0;

    // ACK handshake -> triggers first data write ("hello-rto")
    await harness.sendFrame(buildTcpFrame(41000, 80, 101, serverSeq, 0x10));
    const first = parseTcpFrame(await harness.receiveFrame());
    assert.equal(first.seq, serverSeq);
    assert.equal(new TextDecoder().decode(first.payload), "hello-rto");

    // Simulate drop of first segment: wait for RTO retransmission with identical sequence & payload.
    const rtoRetransmit = parseTcpFrame(await harness.receiveFrame());
    assert.equal(rtoRetransmit.seq, first.seq);
    assert.equal(new TextDecoder().decode(rtoRetransmit.payload), "hello-rto");

    // ACK first segment -> triggers second data write ("fast-dup")
    const nextSeq = (serverSeq + first.payload.byteLength) >>> 0;
    await harness.sendFrame(buildTcpFrame(41000, 80, 101, nextSeq, 0x10));
    const second = parseTcpFrame(await harness.receiveFrame());
    assert.equal(second.seq, nextSeq);
    assert.equal(new TextDecoder().decode(second.payload), "fast-dup");

    // Send 3 duplicate ACKs for nextSeq -> triggers immediate fast retransmit
    for (let i = 0; i < 3; i++) {
      await harness.sendFrame(buildTcpFrame(41000, 80, 101, nextSeq, 0x10));
    }
    const fastRetransmit = parseTcpFrame(await harness.receiveFrame());
    assert.equal(fastRetransmit.seq, nextSeq);
    assert.equal(new TextDecoder().decode(fastRetransmit.payload), "fast-dup");

    // ACK second segment and FIN
    const finSeq = (nextSeq + second.payload.byteLength) >>> 0;
    await harness.sendFrame(buildTcpFrame(41000, 80, 101, finSeq, 0x10));
    const fin = parseTcpFrame(await harness.receiveFrame());
    assert.ok((fin.flags & 0x01) !== 0);
    await harness.sendFrame(buildTcpFrame(41000, 80, 101, (fin.seq + 1) >>> 0, 0x10));
  } finally {
    network.close();
    await harness.close();
  }
});
