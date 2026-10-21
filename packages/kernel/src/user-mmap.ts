// SPDX-License-Identifier: MIT

import type { WasmAddress, WasmAddressType } from "./wasm.ts";

/** Never send replacement requests to legacy allocators that ignore FIXED. */
export function user_mmap_fixed(
  exports: WebAssembly.Exports,
  addressType: WasmAddressType,
  addr: WasmAddress,
  len: WasmAddress,
): WasmAddress {
  const callback = exports.__wasm_mmap_fixed;
  if (typeof callback !== "function") return addressType === "i64" ? -38n : -38;
  return callback(addr, len) as WasmAddress;
}

/** Only the allocator can authorize discard without erasing unrelated bytes. */
export function user_madvise(
  exports: WebAssembly.Exports,
  addressType: WasmAddressType,
  addr: WasmAddress,
  len: WasmAddress,
  advice: number,
): WasmAddress {
  const callback = exports.__wasm_madvise;
  if (typeof callback !== "function") return addressType === "i64" ? -38n : -38;
  return callback(addr, len, advice) as WasmAddress;
}

/** Private mapping coverage is checked by the process allocator, not guessed
 * from linear-memory bounds. An older allocator must refuse, never fake sync. */
export function user_msync(
  exports: WebAssembly.Exports,
  addressType: WasmAddressType,
  addr: WasmAddress,
  len: WasmAddress,
  flags: number,
): WasmAddress {
  const callback = exports.__wasm_msync;
  if (typeof callback !== "function") return addressType === "i64" ? -38n : -38;
  return callback(addr, len, flags) as WasmAddress;
}

/** Standard mremap admission belongs to Linux; old allocators refuse explicitly. */
export function user_mremap(
  exports: WebAssembly.Exports,
  addressType: WasmAddressType,
  addr: WasmAddress,
  oldLen: WasmAddress,
  newLen: WasmAddress,
  flags: WasmAddress,
): WasmAddress {
  const callback = exports.__wasm_mremap;
  if (typeof callback !== "function") return addressType === "i64" ? -38n : -38;
  return callback(addr, oldLen, newLen, flags) as WasmAddress;
}

/** Forward the versioned request, limiting length-only modules to their original subset. */
export function user_mmap(
  exports: WebAssembly.Exports,
  address_type: WasmAddressType,
  addr: WasmAddress,
  len: WasmAddress,
  prot: number,
  flags: number,
  fd: number,
  pgoff: WasmAddress,
): WasmAddress {
  const callback = exports.__wasm_mmap_v2;
  if (typeof callback === "function") {
    return callback(addr, len, prot, flags, fd, pgoff) as WasmAddress;
  }

  const error = (errno: number) => (address_type === "i64" ? BigInt(-errno) : -errno);
  // MAP_FIXED and MAP_FIXED_NOREPLACE cannot be implemented by ignoring addr.
  // Reject before invoking the allocator, so failure cannot allocate or replace memory.
  if (flags & (0x10 | 0x100000)) return error(12); // ENOMEM
  // Only private anonymous read/write mappings can use the length-only ABI.
  // Non-fixed hints may legally be ignored.
  if (flags !== (0x02 | 0x20) || prot !== 3 || fd !== -1 || (pgoff !== 0 && pgoff !== 0n))
    return error(22); // EINVAL

  const legacy_callback = exports.__wasm_mmap;
  if (typeof legacy_callback !== "function") return error(38); // ENOSYS
  return legacy_callback(len) as WasmAddress;
}
