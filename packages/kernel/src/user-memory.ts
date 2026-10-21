// SPDX-License-Identifier: MIT
// Linux user-access residue: zero means success, otherwise bytes not copied.
// A C NULL user pointer is not a mapping, even though Wasm memory contains byte 0.
import { memory_bytes, wasm_address_to_number, type WasmAddress } from "./wasm.ts";

function copy(
  destination: WebAssembly.Memory,
  to: WasmAddress,
  source: WebAssembly.Memory,
  from: WasmAddress,
  length: WasmAddress,
  userPointer: WasmAddress,
): number {
  const count = wasm_address_to_number(length, "copy length");
  if (!count) return 0;
  if (userPointer === 0 || userPointer === 0n) return count;
  const output = memory_bytes(destination, to, count);
  const input = memory_bytes(source, from, count);
  if (!output || !input) return count;
  try {
    output.set(input);
    return 0;
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
  return copy(kernel, to, user, from, length, from);
}

export function write_user_memory(
  user: WebAssembly.Memory,
  to: WasmAddress,
  kernel: WebAssembly.Memory,
  from: WasmAddress,
  length: WasmAddress,
): number {
  return copy(user, to, kernel, from, length, to);
}

export function clear_user_memory(
  user: WebAssembly.Memory,
  to: WasmAddress,
  length: WasmAddress,
): number {
  const count = wasm_address_to_number(length, "zero fill length");
  if (!count) return 0;
  if (to === 0 || to === 0n) return count;
  const output = memory_bytes(user, to, count);
  if (!output) return count;
  try {
    output.fill(0);
    return 0;
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
