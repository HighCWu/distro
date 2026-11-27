// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { getMachinePlugin } from "@lowland/kernel/plugin";
// @ts-ignore Internal virtio test transport shares the compiled @lowland/kernel symbols.
import { close_virtio_device, connect_virtio_device } from "../../kernel/dist/virtio/core.js";
import { guestAgent } from "../src/agent.ts";
import { createNetwork, type UdpSession } from "../src/network.ts";

function ipv4Checksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.byteLength; i += 2) {
    sum += (bytes[i]! << 8) | (bytes[i + 1] ?? 0);
  }
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

function buildUdpFrame(
  sourceIp: readonly [number, number, number, number],
  destIp: readonly [number, number, number, number],
  sourcePort: number,
  destPort: number,
  payload: Uint8Array,
): Uint8Array {
  const udpLength = 8 + payload.byteLength;
  const ipLength = 20 + udpLength;
  const frame = new Uint8Array(12 + 14 + ipLength);
  const view = new DataView(frame.buffer);
  // Virtio-net 12-byte zero header, then Ethernet header (dst=GATEWAY_MAC, src=02:00:00:00:00:02)
  frame.set([2, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 2], 12);
  view.setUint16(24, 0x0800);
  const ip = 26;
  frame[ip] = 0x45;
  view.setUint16(ip + 2, ipLength);
  frame[ip + 8] = 64;
  frame[ip + 9] = 17; // UDP
  frame.set(sourceIp, ip + 12);
  frame.set(destIp, ip + 16);
  view.setUint16(ip + 10, ipv4Checksum(frame.subarray(ip, ip + 20)));
  const udp = ip + 20;
  view.setUint16(udp, sourcePort);
  view.setUint16(udp + 2, destPort);
  view.setUint16(udp + 4, udpLength);
  frame.set(payload, udp + 8);
  return frame;
}

function parseUdpFrame(frame: DataView) {
  assert.equal(frame.getUint16(12), 0x0800);
  const ip = 14;
  assert.equal(frame.getUint8(ip + 9), 17);
  const sourceIp = [
    frame.getUint8(ip + 12),
    frame.getUint8(ip + 13),
    frame.getUint8(ip + 14),
    frame.getUint8(ip + 15),
  ];
  const destIp = [
    frame.getUint8(ip + 16),
    frame.getUint8(ip + 17),
    frame.getUint8(ip + 18),
    frame.getUint8(ip + 19),
  ];
  const ihl = (frame.getUint8(ip) & 0x0f) * 4;
  const udp = ip + ihl;
  const sourcePort = frame.getUint16(udp);
  const destPort = frame.getUint16(udp + 2);
  const udpLength = frame.getUint16(udp + 4);
  const payload = new Uint8Array(
    frame.buffer,
    frame.byteOffset + udp + 8,
    udpLength - 8,
  );
  return { sourceIp, destIp, sourcePort, destPort, payload };
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
    const descriptor = txSlot * 16;
    const address = 16384 + txSlot++ * 2048;
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
    const descriptor = 256 + rxSlot * 16;
    const address = 4096 + rxSlot++ * 2048;
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

test("outbound UDP forwards external datagrams, reuses flow, and delivers replies", async () => {
  const sessions: UdpSession[] = [];
  const network = createNetwork({
    connectTcp() {
      assert.fail("unexpected TCP");
    },
    async resolveDns() {
      assert.fail("unexpected DNS");
    },
    async connectUdp(session) {
      sessions.push(session);
      const reader = session.readable.getReader();
      const writer = session.writable.getWriter();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const reply = new Uint8Array(value.byteLength);
          for (let i = 0; i < value.byteLength; i++) reply[i] = value[i]! ^ 0xff;
          await writer.write(reply);
        }
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    },
  });
  const harness = createVirtioHarness(network);
  try {
    const p1 = new Uint8Array([1, 2, 3, 4]);
    const p2 = new Uint8Array([10, 20, 30]);
    await harness.sendFrame(buildUdpFrame([192, 0, 2, 2], [8, 8, 8, 8], 40001, 5353, p1));
    const r1 = parseUdpFrame(await harness.receiveFrame());
    assert.deepEqual(r1.sourceIp, [8, 8, 8, 8]);
    assert.deepEqual(r1.destIp, [192, 0, 2, 2]);
    assert.equal(r1.sourcePort, 5353);
    assert.equal(r1.destPort, 40001);
    assert.deepEqual([...r1.payload], [254, 253, 252, 251]);

    await harness.sendFrame(buildUdpFrame([192, 0, 2, 2], [8, 8, 8, 8], 40001, 5353, p2));
    const r2 = parseUdpFrame(await harness.receiveFrame());
    assert.deepEqual([...r2.payload], [245, 235, 225]);

    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.target, { hostname: "8.8.8.8", port: 5353 });
    assert.equal(sessions[0]!.signal.aborted, false);
  } finally {
    network.close();
    await harness.close();
  }
  assert.equal(sessions[0]!.signal.aborted, true);
});

test("outbound UDP maps gateway IP (non-DNS) to 127.0.0.1 and preserves reply source IP", async () => {
  let seenTarget: UdpSession["target"] | undefined;
  const network = createNetwork({
    connectTcp() {
      assert.fail("unexpected TCP");
    },
    async resolveDns() {
      assert.fail("unexpected DNS");
    },
    async connectUdp(session) {
      seenTarget = session.target;
      const reader = session.readable.getReader();
      const writer = session.writable.getWriter();
      try {
        const { value } = await reader.read();
        if (value) await writer.write(value);
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    },
  });
  const harness = createVirtioHarness(network);
  try {
    const payload = new TextEncoder().encode("gw-udp");
    await harness.sendFrame(buildUdpFrame([192, 0, 2, 2], [192, 0, 2, 1], 40002, 9000, payload));
    const reply = parseUdpFrame(await harness.receiveFrame());
    assert.deepEqual(seenTarget, { hostname: "127.0.0.1", port: 9000 });
    assert.deepEqual(reply.sourceIp, [192, 0, 2, 1]);
    assert.equal(reply.sourcePort, 9000);
    assert.equal(reply.destPort, 40002);
    assert.equal(new TextDecoder().decode(reply.payload), "gw-udp");
  } finally {
    network.close();
    await harness.close();
  }
});

test("omitting connectUdp drops outbound UDP while keeping DNS functional", async () => {
  const network = createNetwork({
    connectTcp() {
      assert.fail("unexpected TCP");
    },
    async resolveDns(hostname) {
      assert.equal(hostname, "example.com");
      return ["93.184.216.34"];
    },
  });
  const harness = createVirtioHarness(network);
  try {
    // Non-DNS outbound UDP is silently dropped
    await harness.sendFrame(
      buildUdpFrame([192, 0, 2, 2], [8, 8, 8, 8], 40003, 5353, Uint8Array.of(1, 2, 3)),
    );
    // DNS query to 192.0.2.1:53 still succeeds
    const dnsQuery = Uint8Array.of(
      0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      7, ...new TextEncoder().encode("example"), 3, ...new TextEncoder().encode("com"), 0,
      0x00, 0x01, 0x00, 0x01,
    );
    await harness.sendFrame(buildUdpFrame([192, 0, 2, 2], [192, 0, 2, 1], 40004, 53, dnsQuery));
    const reply = parseUdpFrame(await harness.receiveFrame());
    assert.deepEqual(reply.sourceIp, [192, 0, 2, 1]);
    assert.equal(reply.sourcePort, 53);
    assert.equal(reply.destPort, 40004);
  } finally {
    network.close();
    await harness.close();
  }
});

test("rejected connectUdp cleans up flow and allows subsequent datagram to open a new flow", async () => {
  let attempts = 0;
  let firstSignal: AbortSignal | undefined;
  const network = createNetwork({
    connectTcp() {
      assert.fail("unexpected TCP");
    },
    async resolveDns() {
      assert.fail("unexpected DNS");
    },
    async connectUdp(session) {
      attempts++;
      if (attempts === 1) {
        firstSignal = session.signal;
        throw new Error("udp dial failed");
      }
      const reader = session.readable.getReader();
      const writer = session.writable.getWriter();
      try {
        const { value } = await reader.read();
        if (value) await writer.write(value);
      } finally {
        reader.releaseLock();
        writer.releaseLock();
      }
    },
  });
  const harness = createVirtioHarness(network);
  try {
    await harness.sendFrame(
      buildUdpFrame([192, 0, 2, 2], [1, 1, 1, 1], 40005, 5000, Uint8Array.of(9)),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(firstSignal?.aborted, true);

    await harness.sendFrame(
      buildUdpFrame([192, 0, 2, 2], [1, 1, 1, 1], 40005, 5000, Uint8Array.of(42)),
    );
    const reply = parseUdpFrame(await harness.receiveFrame());
    assert.equal(attempts, 2);
    assert.deepEqual([...reply.payload], [42]);
  } finally {
    network.close();
    await harness.close();
  }
});
