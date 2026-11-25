// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { copy_fork_memory_to_fresh_target } from "../src/fork-memory-copy.ts";

const pageSize = 0x10000;

class TrackedTarget extends Uint8Array<SharedArrayBuffer> {
  readonly writes: [number, number][] = [];

  constructor(buffer: SharedArrayBuffer, byteOffset = 0, length = buffer.byteLength - byteOffset) {
    super(buffer, byteOffset, length);
  }

  override set(source: ArrayLike<number>, offset = 0): void {
    this.writes.push([offset, source.length]);
    super.set(source, offset);
  }
}

test("fork copy preserves sparse shared bytes while zero pages never reach set", () => {
  const length = 4 * pageSize + 3;
  const source = new Uint8Array(new SharedArrayBuffer(length));
  source[0] = 1;
  source[pageSize - 1] = 2;
  source[2 * pageSize + 19] = 3;
  source[length - 1] = 4;
  const before = source.slice();
  const target = new TrackedTarget(new SharedArrayBuffer(length));
  copy_fork_memory_to_fresh_target(source, target);
  assert.deepEqual(new Uint8Array(target.buffer), before);
  assert.deepEqual(source, before);
  assert.deepEqual(target.writes, [
    [0, pageSize],
    [2 * pageSize, pageSize],
    [4 * pageSize, 3],
  ]);
});

test("fork copy bounds aligned word scans to unaligned views and partial tails", () => {
  for (const byteOffset of [1, 2, 3, 4, 7]) {
    for (const length of [0, 1, 2, 3, 4, 5, pageSize + 1, pageSize + 3]) {
      const backing = new Uint8Array(new SharedArrayBuffer(byteOffset + length + 4)).fill(0xa5);
      const source = backing.subarray(byteOffset, byteOffset + length);
      source.fill(0);
      const target = new TrackedTarget(new SharedArrayBuffer(length + 6), 3, length);
      copy_fork_memory_to_fresh_target(source, target);
      assert.deepEqual(target.writes, [], "nonzero bytes outside the source view are ignored");
      assert.deepEqual(new Uint8Array(target.buffer), new Uint8Array(length + 6));
      if (length) {
        source[length - 1] = 0x80;
        copy_fork_memory_to_fresh_target(source, target);
        assert.deepEqual(new Uint8Array(target.buffer, target.byteOffset, length), source);
        const block = Math.floor((length - 1) / pageSize) * pageSize;
        assert.deepEqual(target.writes, [[block, length - block]]);
        assert.equal(new Uint8Array(target.buffer)[0], 0);
        assert.equal(new Uint8Array(target.buffer)[target.byteOffset + length], 0);
      }
    }
  }
});

test("fork copy detects every byte position around word and chunk boundaries", () => {
  for (const byteOffset of [0, 1, 2, 3]) {
    const length = pageSize + 8;
    const source = new Uint8Array(new SharedArrayBuffer(length + byteOffset), byteOffset, length);
    for (const position of [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      pageSize - 4,
      pageSize - 1,
      pageSize,
      length - 1,
    ]) {
      source[position] = 0x80;
      const target = new TrackedTarget(new SharedArrayBuffer(length));
      copy_fork_memory_to_fresh_target(source, target);
      assert.deepEqual(new Uint8Array(target.buffer), source);
      const block = Math.floor(position / pageSize) * pageSize;
      assert.deepEqual(target.writes, [[block, Math.min(pageSize, length - block)]]);
      source[position] = 0;
    }
  }
});

test("fork copy rejects mismatched lengths before publishing any bytes", () => {
  for (const [sourceLength, targetLength] of [
    [1, 0],
    [0, 1],
    [pageSize + 1, pageSize],
  ] as const) {
    const source = new Uint8Array(sourceLength).fill(1);
    const target = new TrackedTarget(new SharedArrayBuffer(targetLength));
    assert.throws(() => copy_fork_memory_to_fresh_target(source, target), RangeError);
    assert.deepEqual(target.writes, []);
    assert.deepEqual(new Uint8Array(target.buffer), new Uint8Array(targetLength));
  }
});
