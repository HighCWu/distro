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

function buildUdpFragmentFrame(
  destIp: readonly [number, number, number, number],
  id: number,
  offsetBytes: number,
  moreFragments: boolean,
  fragmentPayload: Uint8Array,
): Uint8Array {
  const ipLength = 20 + fragmentPayload.byteLength;
  const frame = new Uint8Array(12 + 14 + ipLength);
  const view = new DataView(frame.buffer);
  frame.set([2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2], 12);
  view.setUint16(24, 0x0800);
  const ip = 26;
  frame[ip] = 0x45;
  view.setUint16(ip + 2, ipLength);
  view.setUint16(ip + 4, id);
  view.setUint16(ip + 6, (moreFragments ? 0x2000 : 0) | (offsetBytes >>> 3));
  frame[ip + 8] = 64;
  frame[ip + 9] = 17;
  frame.set([192, 0, 2, 2, ...destIp], ip + 12);
  view.setUint16(ip + 10, ipv4Checksum(frame.subarray(ip, ip + 20)));
  frame.set(fragmentPayload, ip + 20);
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
  return {
    seq: frame.getUint32(tcp + 4),
    ack: frame.getUint32(tcp + 8),
    flags: frame.getUint8(tcp + 13),
    payload: new Uint8Array(
      frame.buffer,
      frame.byteOffset + tcp + dataOffset,
      totalLength - ihl - dataOffset,
    ),
  };
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
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
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
    const address = 32768 + (txSlot++ % 8) * 2048;
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

test("TCP rejects out-of-order guest segments with dup ACK and resumes on window open", async () => {
  const accepted = Promise.withResolvers<TcpSession>();
  const receivedChunks: string[] = [];
  const network = createNetwork({
    async connectTcp(session) {
      accepted.resolve(session);
      const reader = session.readable.getReader();
      const writer = session.writable.getWriter();
      try {
        const { value } = await reader.read();
        if (value) receivedChunks.push(new TextDecoder().decode(value));
        await writer.write(new TextEncoder().encode("unblocked"));
        await writer.close();
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    },
    async resolveDns() {
      assert.fail("unexpected DNS");
    },
  });
  const harness = createVirtioHarness(network);
  try {
    // SYN with window=0 to test zero-window pause
    await harness.sendFrame(buildTcpFrame(42000, 80, 100, 0, 0x02, 0));
    await accepted.promise;
    const synAck = parseTcpFrame(await harness.receiveFrame());
    const serverSeq = (synAck.seq + 1) >>> 0;
    await harness.sendFrame(buildTcpFrame(42000, 80, 101, serverSeq, 0x10, 0));

    // Out-of-order guest segment (seq=105 instead of 101) -> bridge responds with ACK 101
    await harness.sendFrame(
      buildTcpFrame(42000, 80, 105, serverSeq, 0x18, 0, new TextEncoder().encode("late")),
    );
    const dupAck = parseTcpFrame(await harness.receiveFrame());
    assert.equal(dupAck.ack, 101);
    assert.deepEqual(receivedChunks, []);

    // In-order segment (seq=101) + window reopen (window=1024)
    await harness.sendFrame(
      buildTcpFrame(42000, 80, 101, serverSeq, 0x18, 1024, new TextEncoder().encode("abcd")),
    );
    const ack105 = parseTcpFrame(await harness.receiveFrame());
    assert.equal(ack105.ack, 105);
    assert.deepEqual(receivedChunks, ["abcd"]);

    // Host write ("unblocked") now proceeds
    const data = parseTcpFrame(await harness.receiveFrame());
    assert.equal(new TextDecoder().decode(data.payload), "unblocked");
    await harness.sendFrame(
      buildTcpFrame(42000, 80, 105, (serverSeq + data.payload.byteLength) >>> 0, 0x10, 1024),
    );
  } finally {
    network.close();
    await harness.close();
  }
});

test("UDP drops broadcast/multicast outbound packets and reassembles fragmented datagrams", async () => {
  const delivered: Uint8Array[] = [];
  let sessionCount = 0;
  const network = createNetwork({
    connectTcp() {
      assert.fail("unexpected TCP");
    },
    async resolveDns() {
      assert.fail("unexpected DNS");
    },
    async connectUdp(session) {
      sessionCount++;
      const reader = session.readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          delivered.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
  const harness = createVirtioHarness(network);
  try {
    // Multicast & broadcast must be ignored
    for (const dest of [
      [224, 0, 0, 1],
      [255, 255, 255, 255],
      [192, 0, 2, 255],
    ] as const) {
      const udp = new Uint8Array(12);
      const dv = new DataView(udp.buffer);
      dv.setUint16(0, 42001);
      dv.setUint16(2, 5353);
      dv.setUint16(4, 12);
      udp.set([1, 2, 3, 4], 8);
      await harness.sendFrame(buildUdpFragmentFrame(dest, 7, 0, false, udp));
    }
    assert.equal(sessionCount, 0);

    // Fragmented unicast UDP datagram (16-byte payload split across 2 IPv4 fragments)
    const fullUdp = new Uint8Array(24);
    const dv = new DataView(fullUdp.buffer);
    dv.setUint16(0, 42002);
    dv.setUint16(2, 9999);
    dv.setUint16(4, 24);
    for (let i = 0; i < 16; i++) fullUdp[8 + i] = i + 1;

    await harness.sendFrame(
      buildUdpFragmentFrame([8, 8, 4, 4], 42, 0, true, fullUdp.subarray(0, 16)),
    );
    await harness.sendFrame(
      buildUdpFragmentFrame([8, 8, 4, 4], 42, 16, false, fullUdp.subarray(16)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessionCount, 1);
    assert.equal(delivered.length, 1);
    assert.deepEqual([...delivered[0]!], [...fullUdp.subarray(8)]);
  } finally {
    network.close();
    await harness.close();
  }
});
