// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  DylinkWorkerSnapshotError,
  type DylinkWorkerPublication,
} from "../src/dylink_process_worker.ts";
import { decode_linux_bytes, encode_linux_string } from "../src/linux-string.ts";
import {
  decode_dylink_worker_publication,
  encode_dylink_worker_publication,
} from "../src/dylink_worker_transport.ts";

const encodeData = (value: unknown) =>
  encode_dylink_worker_publication(value as DylinkWorkerPublication);
const MAGIC = [0x44, 0x57, 0x50, 0x55];
const HEADER_BYTES = 12;
const MAX_WIRE_BYTES = 64 * 1024 * 1024;
const TAG_STRING = 5;

function envelope(payload: readonly number[], version = 2): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(HEADER_BYTES + payload.length);
  result.set(MAGIC, 0);
  const header = new DataView(result.buffer);
  header.setUint32(4, version, true);
  header.setUint32(8, payload.length, true);
  result.set(payload, HEADER_BYTES);
  return result;
}

function assertSnapshotError(action: () => unknown, code: DylinkWorkerSnapshotError["code"]): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof DylinkWorkerSnapshotError && error.code === code,
  );
}

test("publication transport round-trips data values and owns decoded bytes", () => {
  const bytes = new Uint8Array([0x10, 0x20, 0x30, 0x40]).subarray(1, 3);
  const value = Object.create(null) as Record<string, unknown>;
  value.version = 1;
  value.processIdentity = "worker-α\uFEFF";
  value.bigints = [0n, -1n, (1n << 127n) + 0x123456789abcdefn, -(1n << 95n)];
  value.numbers = [-0, Number.MIN_VALUE, Number.MAX_VALUE];
  value.bytes = bytes;
  value.array = [null, false, true, "snowman ☃", { nested: [1, 2n] }];
  Object.defineProperty(value, "__proto__", { value: "data, not a prototype", enumerable: true });

  const wire = encodeData(value);
  assert.ok(wire.buffer instanceof ArrayBuffer);
  assert.equal(wire.byteOffset, 0);
  assert.equal(new DataView(wire.buffer).getUint32(4, true), 2);
  assert.equal(new DataView(wire.buffer).getUint32(8, true), wire.byteLength - HEADER_BYTES);

  const decoded = decode_dylink_worker_publication(wire) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(decoded), null);
  assert.equal(decoded.version, 1);
  assert.equal(decoded.processIdentity, "worker-α\uFEFF");
  assert.deepEqual(decoded.bigints, value.bigints);
  const numbers = decoded.numbers as number[];
  assert.ok(Object.is(numbers[0], -0));
  assert.equal(numbers[1], Number.MIN_VALUE);
  assert.equal(numbers[2], Number.MAX_VALUE);
  assert.deepEqual(decoded.bytes, new Uint8Array([0x20, 0x30]));
  assert.ok((decoded.bytes as Uint8Array).buffer instanceof ArrayBuffer);
  assert.deepEqual(decoded.array, [
    null,
    false,
    true,
    "snowman ☃",
    Object.assign(Object.create(null), { nested: [1, 2n] }),
  ]);
  assert.equal(Object.hasOwn(decoded, "__proto__"), true);
  assert.equal(decoded.__proto__, "data, not a prototype");
});

test("publication decoder accepts a frozen SharedArrayBuffer view and copies byte values", () => {
  const encoded = encodeData({ bytes: new Uint8Array([3, 1, 4, 1, 5]) });
  const shared = new SharedArrayBuffer(encoded.byteLength + 6);
  const sharedView = new Uint8Array(shared, 3, encoded.byteLength);
  sharedView.set(encoded);
  const decoded = decode_dylink_worker_publication(sharedView) as Record<string, unknown>;
  const copy = decoded.bytes as Uint8Array;
  assert.ok(copy.buffer instanceof ArrayBuffer);
  assert.deepEqual(copy, new Uint8Array([3, 1, 4, 1, 5]));
});

test("publication transport rejects executable, cyclic, non-finite, and ill-formed values", () => {
  let getterCalls = 0;
  const accessor: Record<string, unknown> = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get() {
      getterCalls++;
      return 1;
    },
  });
  const cycle: unknown[] = [];
  cycle.push(cycle);

  for (const value of [
    undefined,
    () => 1,
    Symbol("x"),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    accessor,
    cycle,
    new Date(),
  ]) {
    assertSnapshotError(() => encodeData(value), "EINVAL");
  }
  assert.equal(getterCalls, 0);
  assertSnapshotError(() => encodeData("unpaired \ud800"), "EINVAL");
  assertSnapshotError(() => encodeData("unpaired \udc00"), "EINVAL");
  assertSnapshotError(() => encodeData("unpaired \udcffx\udfff"), "EINVAL");
});

test("publication strings preserve Linux byte escapes and valid surrogate pairs", () => {
  const escapedByte = `path/${decode_linux_bytes(Uint8Array.of(0xff))}`;
  const scalarWithEscapedLookingLowHalf = "\ud800\udc80";
  const replacementCharacter = "\ufffd";
  const value = { escapedByte, scalarWithEscapedLookingLowHalf, replacementCharacter };

  const wire = encodeData(value);
  const decoded = decode_dylink_worker_publication(wire) as typeof value;
  assert.equal(decoded.escapedByte, escapedByte);
  assert.equal(decoded.scalarWithEscapedLookingLowHalf, scalarWithEscapedLookingLowHalf);
  assert.equal(decoded.replacementCharacter, replacementCharacter);
  assert.deepEqual(
    encode_linux_string(decoded.escapedByte),
    Uint8Array.of(0x70, 0x61, 0x74, 0x68, 0x2f, 0xff),
  );
  assert.deepEqual(
    encode_linux_string(decoded.scalarWithEscapedLookingLowHalf),
    new TextEncoder().encode(scalarWithEscapedLookingLowHalf),
  );
  assert.notEqual(decoded.escapedByte, replacementCharacter);
  assert.deepEqual(
    encode_linux_string(decoded.replacementCharacter),
    new TextEncoder().encode(replacementCharacter),
  );
});

test("publication transport caps container depth at 64", () => {
  let accepted: unknown = null;
  for (let depth = 0; depth < 64; depth++) accepted = [accepted];
  assert.doesNotThrow(() => decode_dylink_worker_publication(encodeData(accepted)));

  let rejected: unknown = null;
  for (let depth = 0; depth < 65; depth++) rejected = [rejected];
  assertSnapshotError(() => encodeData(rejected), "EINVAL");
});

test("publication transport rejects malformed headers, payloads, tags, and trailing bytes", () => {
  const linuxByteEscape = envelope([TAG_STRING, 1, 0, 0, 0, 0xff]);
  assert.equal(decode_dylink_worker_publication(linuxByteEscape), String.fromCharCode(0xdcff));
  assertSnapshotError(() => decode_dylink_worker_publication(envelope([0xff])), "EINVAL");
  assertSnapshotError(() => decode_dylink_worker_publication(envelope([0], 1)), "EOPNOTSUPP");

  const trailing = new Uint8Array(14);
  trailing.set(envelope([0]));
  trailing[13] = 0;
  assertSnapshotError(() => decode_dylink_worker_publication(trailing), "EINVAL");

  const badMagic = envelope([0]);
  badMagic[0] = badMagic[0]! ^ 1;
  assertSnapshotError(() => decode_dylink_worker_publication(badMagic), "EINVAL");

  const oversizedLength = envelope([0]);
  new DataView(oversizedLength.buffer).setUint32(8, 0xffff_ffff, true);
  assertSnapshotError(() => decode_dylink_worker_publication(oversizedLength), "EINVAL");
});

test("publication transport enforces the 64 MiB wire cap", () => {
  const oversized = new Uint8Array(MAX_WIRE_BYTES + 1);
  assertSnapshotError(() => decode_dylink_worker_publication(oversized), "EINVAL");
});
