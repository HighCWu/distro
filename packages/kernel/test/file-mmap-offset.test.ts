// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { decode_file_mmap_offset, validate_file_mmap_extent } from "../src/file-mmap-offset.ts";

test("zero offsets and unaligned lengths are valid before file admission", () => {
  assert.deepEqual(decode_file_mmap_offset("i32", 0), { ok: true, byte_offset: 0n });
  assert.deepEqual(decode_file_mmap_offset("i64", 0n), { ok: true, byte_offset: 0n });
  assert.deepEqual(validate_file_mmap_extent(0n, 65537n), {
    ok: true,
    byte_offset: 0n,
    rounded_length: 131072n,
    end_exclusive: 131072n,
  });
});

test("mmap2 units and mmap bytes describe the same nonzero file offset", () => {
  for (const bytes of [65536n, 1n << 32n, (1n << 44n) - 65536n]) {
    const expected = { ok: true, byte_offset: bytes };
    assert.deepEqual(decode_file_mmap_offset("i32", Number(bytes / 4096n)), expected);
    assert.deepEqual(decode_file_mmap_offset("i64", bytes), expected);
    assert.deepEqual(validate_file_mmap_extent(bytes, 1n), {
      ok: true,
      byte_offset: bytes,
      rounded_length: 65536n,
      end_exclusive: bytes + 65536n,
    });
  }
});

test("signed i32 transport preserves all unsigned mmap2 bits before widening", () => {
  assert.deepEqual(decode_file_mmap_offset("i32", -1), {
    ok: true,
    byte_offset: (1n << 44n) - 4096n,
  });
  assert.deepEqual(decode_file_mmap_offset("i32", -0x8000_0000), {
    ok: true,
    byte_offset: 1n << 43n,
  });
  assert.deepEqual(decode_file_mmap_offset("i32", -1), decode_file_mmap_offset("i32", 0xffff_ffff));
});

test("syscall units do not imply mapping-page alignment", () => {
  assert.deepEqual(decode_file_mmap_offset("i32", 1), { ok: true, byte_offset: 4096n });
  for (const bytes of [1n, 4096n, (1n << 44n) - 4096n])
    assert.deepEqual(validate_file_mmap_extent(bytes, 65536n), { ok: false, errno: 22 });
});

test("i64 offsets retain precision above Number's exact range", () => {
  const bytes = (1n << 53n) + 1n;
  assert.deepEqual(decode_file_mmap_offset("i64", bytes), { ok: true, byte_offset: bytes });
  assert.deepEqual(decode_file_mmap_offset("i64", Number(bytes)), { ok: false, errno: 22 });
});

test("invalid raw types and widths are rejected rather than truncated", () => {
  for (const raw of [NaN, Infinity, 0.5, -0x8000_0001, 0x1_0000_0000, 16n])
    assert.deepEqual(decode_file_mmap_offset("i32", raw), { ok: false, errno: 22 });
  for (const raw of [0, -1n])
    assert.deepEqual(decode_file_mmap_offset("i64", raw), { ok: false, errno: 22 });
  assert.deepEqual(decode_file_mmap_offset("i64", 1n << 63n), { ok: false, errno: 75 });
});

test("page rounding and exclusive extent must fit a signed 64-bit file position", () => {
  const last_page = (1n << 63n) - 65536n;
  assert.deepEqual(validate_file_mmap_extent(last_page - 65536n, 65536n), {
    ok: true,
    byte_offset: last_page - 65536n,
    rounded_length: 65536n,
    end_exclusive: last_page,
  });
  for (const [offset, length] of [
    [last_page, 1n],
    [0n, 1n << 63n],
    [1n << 64n, 1n],
  ] as const)
    assert.deepEqual(validate_file_mmap_extent(offset, length), { ok: false, errno: 75 });
});

test("invalid lengths, offsets and page sizes fail without a valid extent", () => {
  for (const [offset, length, page] of [
    [-1n, 1n, 65536n],
    [0n, 0n, 65536n],
    [0n, -1n, 65536n],
    [0n, 1n, 0n],
    [0n, 1n, 3n],
  ] as const)
    assert.deepEqual(validate_file_mmap_extent(offset, length, page), { ok: false, errno: 22 });
});
