// SPDX-License-Identifier: MIT

import type { WasmAddress, WasmAddressType } from "./wasm.ts";

type OffsetError = { ok: false; errno: 22 | 75 };
type OffsetResult = { ok: true; byte_offset: bigint } | OffsetError;
type ExtentResult =
  | { ok: true; byte_offset: bigint; rounded_length: bigint; end_exclusive: bigint }
  | OffsetError;

const max_file_position = (1n << 63n) - 1n;

/** Experimental contract model, not a syscall handler or a new Wasm import.
 * Decode raw syscall units once; the future execution interface receives
 * byte_offset as i64 on both pointer widths. Never convert it to Number. */
export function decode_file_mmap_offset(
  address_type: WasmAddressType,
  raw_offset: WasmAddress,
): OffsetResult {
  if (address_type === "i32") {
    // Wasm i32 arrives signed; host-side callers may also use unsigned bits.
    if (
      typeof raw_offset !== "number" ||
      !Number.isInteger(raw_offset) ||
      raw_offset < -0x8000_0000 ||
      raw_offset > 0xffff_ffff
    )
      return { ok: false, errno: 22 };
    return { ok: true, byte_offset: BigInt(raw_offset >>> 0) * 4096n };
  }
  if (typeof raw_offset !== "bigint" || raw_offset < 0n) return { ok: false, errno: 22 };
  if (raw_offset > max_file_position) return { ok: false, errno: 75 };
  return { ok: true, byte_offset: raw_offset };
}

/** Validate a canonical byte offset and the rounded file extent only.
 * This does not validate EOF, permissions, immutability or available memory.
 * There is no backing allocation, file access, or mapping publication here. */
export function validate_file_mmap_extent(
  byte_offset: bigint,
  length: bigint,
  page_size = 65536n,
): ExtentResult {
  if (
    byte_offset < 0n ||
    length <= 0n ||
    page_size <= 0n ||
    (page_size & (page_size - 1n)) !== 0n ||
    byte_offset % page_size !== 0n
  )
    return { ok: false, errno: 22 };
  const rounded_length = ((length + page_size - 1n) / page_size) * page_size;
  const end_exclusive = byte_offset + rounded_length;
  if (byte_offset > max_file_position || end_exclusive > max_file_position)
    return { ok: false, errno: 75 };
  return { ok: true, byte_offset, rounded_length, end_exclusive };
}
