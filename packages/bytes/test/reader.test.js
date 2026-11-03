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
