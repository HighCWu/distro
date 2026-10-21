// SPDX-License-Identifier: MIT
// Linux user-access residue: zero means success, otherwise bytes not copied.
// A C NULL user pointer is not a mapping, even though Wasm memory contains byte 0.
import { memory_bytes, wasm_address_to_number, type WasmAddress } from "./wasm.ts";

function user_prefix(
  user: WebAssembly.Memory,
  pointer: WasmAddress,
  count: number,
): Uint8Array | null {
  if (pointer === 0 || pointer === 0n) return null;
  try {
    const offset = wasm_address_to_number(pointer);
    const available = user.buffer.byteLength - offset;
    return available < 0 ? null : memory_bytes(user, offset, Math.min(count, available));
  } catch {
    return null;
  }
}

function copy(
  user: WebAssembly.Memory,
  userPointer: WasmAddress,
  kernel: WebAssembly.Memory,
  kernelPointer: WasmAddress,
  length: WasmAddress,
  toUser: boolean,
): number {
  const count = wasm_address_to_number(length, "copy length");
  if (!count) return 0;
  const kernelBytes = memory_bytes(kernel, kernelPointer, count);
  const prefix = user_prefix(user, userPointer, count);
  if (!kernelBytes || !prefix) return count;
  try {
    if (toUser) prefix.set(kernelBytes.subarray(0, prefix.byteLength));
    else kernelBytes.set(prefix);
    return count - prefix.byteLength;
  } catch {
    return count;
  }
}

export function read_user_memory(
  kernel: WebAssembly.Memory,
  to: WasmAddress,
  user: WebAssembly.Memory,
  from: WasmAddress,
  length: WasmAddress,
): number {
  return copy(user, from, kernel, to, length, false);
}

export function write_user_memory(
  user: WebAssembly.Memory,
  to: WasmAddress,
  kernel: WebAssembly.Memory,
  from: WasmAddress,
  length: WasmAddress,
): number {
  return copy(user, to, kernel, from, length, true);
}

export function clear_user_memory(
  user: WebAssembly.Memory,
  to: WasmAddress,
  length: WasmAddress,
): number {
  const count = wasm_address_to_number(length, "zero fill length");
  if (!count) return 0;
  const output = user_prefix(user, to, count);
  if (!output) return count;
  try {
    output.fill(0);
    return count - output.byteLength;
  } catch {
    return count;
  }
}

export function user_atomic_word(
  user: WebAssembly.Memory,
  pointer: WasmAddress,
): Int32Array | null {
  try {
    const address = wasm_address_to_number(pointer);
    if (!address || address % 4 !== 0) return null;
    const bytes = memory_bytes(user, address, 4);
    return bytes ? new Int32Array(bytes.buffer, bytes.byteOffset, 1) : null;
  } catch {
    return null;
  }
}
