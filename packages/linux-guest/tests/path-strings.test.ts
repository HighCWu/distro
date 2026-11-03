// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { parse_dirents } from "../src/abi.ts";

test("getdents64 preserves leading U+FEFF and does not mistake marked dots for dot entries", () => {
  const names = [".", "..", "plain", "\uFEFFplain", "\uFEFF.", "\uFEFF\uFEFFx"];
  const records = names.map((name, index) => {
    const bytes = new TextEncoder().encode(name);
    const record = new Uint8Array((19 + bytes.length + 1 + 7) & ~7);
    const view = new DataView(record.buffer);
    view.setBigUint64(0, BigInt(index + 1), true);
    view.setBigUint64(8, BigInt(index + 1), true);
    view.setUint16(16, record.length, true);
    record[18] = 8;
    record.set(bytes, 19);
    return record;
  });
  const combined = new Uint8Array(records.reduce((sum, record) => sum + record.length, 0));
  let offset = 0;
  for (const record of records) {
    combined.set(record, offset);
    offset += record.length;
  }
  assert.deepEqual(
    parse_dirents(combined).map(({ name }) => name),
    names.slice(2),
  );
});
