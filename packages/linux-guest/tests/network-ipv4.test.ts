// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { parseIpv4Frame } from "../src/network-ipv4.ts";

function setChecksum(frame: Uint8Array) {
  const bytes = frame.subarray(14);
  bytes[10] = bytes[11] = 0;
  let sum = 0;
  for (let i = 0; i < (bytes[0]! & 15) * 4; i += 2) {
    sum += bytes[i]! * 256 + bytes[i + 1]!;
  }
  sum = (sum % 65536) + Math.floor(sum / 65536);
  sum = (sum % 65536) + Math.floor(sum / 65536);
  bytes[10] = (65535 - sum) >>> 8;
  bytes[11] = (65535 - sum) & 255;
}

function frame(payload = Uint8Array.of(0, 255, 42), headerLength = 20, padding = 0) {
  const result = new Uint8Array(14 + headerLength + payload.length + padding);
  const header = new DataView(result.buffer, 14);
  result[12] = 8;
  header.setUint8(0, 0x40 | (headerLength / 4));
  header.setUint16(2, headerLength + payload.length);
  header.setUint16(4, 1234);
  header.setUint8(8, 64);
  header.setUint8(9, 17);
  header.setUint32(12, 0xc0000202);
  header.setUint32(16, 0xc0000201);
  if (headerLength > 20) result.fill(1, 34, 14 + headerLength);
  result.set(payload, 14 + headerLength);
  setChecksum(result);
  return result;
}

test("IPv4 parser accepts a known header checksum vector", () => {
  const result = frame(new Uint8Array(95));
  result.set(Buffer.from("45000073000040004011b861c0a80001c0a800c7", "hex"), 14);
  const packet = parseIpv4Frame(result);
  assert(packet);
  assert.equal(packet.source, 0xc0a80001);
  assert.equal(packet.destination, 0xc0a800c7);
  assert.equal(packet.payload.length, 95);
  // Independently generated fixtures must agree with the known checksum.
  setChecksum(result);
  assert.equal(new DataView(result.buffer).getUint16(24), 0xb861);
});

test("IPv4 parser preserves fields, odd payload lengths, padding and empty packets", () => {
  for (const payload of [new Uint8Array(), Uint8Array.of(0, 255, 42)]) {
    const packet = parseIpv4Frame(frame(payload, 20, 30));
    assert(packet);
    assert.equal(packet.source, 0xc0000202);
    assert.equal(packet.destination, 0xc0000201);
    assert.equal(packet.protocol, 17);
    assert.equal(packet.identification, 1234);
    assert.equal(packet.offset, 0);
    assert.equal(packet.more_fragments, false);
    assert.deepEqual(packet.payload, payload);
  }
});

test("IPv4 parser rejects corrupted headers and checksum fields", () => {
  const valid = frame();
  for (const index of [1, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]) {
    const corrupt = valid.slice();
    corrupt[14 + index]! ^= 1;
    assert.equal(parseIpv4Frame(corrupt), undefined, `corrupted header byte ${index}`);
  }
});

test("IPv4 parser includes options, but not payload or Ethernet padding, in its checksum", () => {
  const valid = frame(Uint8Array.of(42), 60, 20);
  assert.equal(parseIpv4Frame(valid)?.header_length, 60);
  valid[34]! ^= 1;
  assert.equal(parseIpv4Frame(valid), undefined, "an option byte is covered");
  setChecksum(valid);
  assert(parseIpv4Frame(valid));
  valid[74]! ^= 1;
  valid[valid.length - 1]! ^= 1;
  assert(parseIpv4Frame(valid), "transport payload and padding have separate integrity rules");
});

test("IPv4 parser honors view offsets for Uint8Array and Node Buffer", () => {
  const original = frame();
  for (const slab of [new Uint8Array(original.length + 16), Buffer.alloc(original.length + 16)]) {
    slab.set(original, 7);
    const packet = parseIpv4Frame(slab.subarray(7, 7 + original.length));
    assert(packet);
    assert.deepEqual([...packet.payload], [0, 255, 42]);
  }
});

test("IPv4 parser rejects truncation, wrong EtherType, version and header/packet lengths", () => {
  const valid = frame();
  for (let length = 0; length < valid.length; length++) {
    assert.equal(parseIpv4Frame(valid.subarray(0, length)), undefined);
  }
  for (const [offset, value] of [
    [12, 0x86],
    [14, 0x65],
    [14, 0x44],
    [14, 0x4f],
    [17, 19],
  ]) {
    const corrupt = valid.slice();
    corrupt[offset!] = value!;
    assert.equal(parseIpv4Frame(corrupt), undefined);
  }
});

test("IPv4 parser validates non-final fragment alignment and maximum reassembled range", () => {
  for (const [length, flags, accepted] of [
    [0, 0x2000, false],
    [1, 0x2000, false],
    [8, 0x2000, true],
    [0, 1, false],
    [3, 1, true],
    [3, 8189, true],
    [4, 8189, false],
  ] as const) {
    const bytes = frame(new Uint8Array(length));
    new DataView(bytes.buffer).setUint16(20, flags);
    setChecksum(bytes);
    const packet = parseIpv4Frame(bytes);
    assert.equal(!!packet, accepted, `length=${length} flags=${flags}`);
    if (packet) assert.equal(packet.offset, (flags & 0x1fff) * 8);
  }
});
