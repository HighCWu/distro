// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { Reader } from "../src/index.ts";

test("protocol C strings preserve leading U+FEFF and consume byte boundaries", () => {
  const values = ["", "plain", "\uFEFF", "\uFEFFname", "\uFEFF\uFEFFname", "x\uFEFFy"];
  const reader = new Reader(new TextEncoder().encode(values.join("\0") + "\0"));
  for (const value of values) assert.equal(reader.cstring(), value);
  assert.throws(() => reader.cstring(), /unterminated/);
});

test("invalid UTF-8 remains rejected instead of becoming another filename", () => {
  for (const bytes of [
    [0xc0, 0xaf, 0],
    [0xed, 0xa0, 0x80, 0],
    [0xff, 0],
    [0xef, 0xbb, 0xbf, 0xff, 0],
  ])
    assert.throws(() => new Reader(Uint8Array.from(bytes)).cstring(), /not valid UTF-8/);
});

test("raw C strings preserve invalid bytes, offsets and unterminated behavior", () => {
  const reader = new Reader(Uint8Array.of(0xaa, 0xc0, 0xaf, 0, 0xff, 0));
  reader.skip(1);
  assert.deepEqual(reader.cstring_bytes(), Uint8Array.of(0xc0, 0xaf));
  assert.equal(reader.offset, 4);
  assert.deepEqual(reader.cstring_bytes(), Uint8Array.of(0xff));
  assert.equal(reader.offset, 6);

  const unterminated = new Reader(Uint8Array.of(0xaa, 0xff));
  unterminated.skip(1);
  assert.throws(() => unterminated.cstring_bytes(), /unterminated/);
  assert.equal(unterminated.offset, 1);
});
