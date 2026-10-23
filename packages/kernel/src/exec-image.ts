// SPDX-License-Identifier: MIT
import {
  memory_bytes,
  wasm_pointer_to_number,
  wasm_size_to_number,
  refresh_memory_range,
  type WasmAddress,
} from "./wasm.ts";

/** Internal compile_write boundary. Linux retains exec state and abort ownership.
 * Source is a kernel pointer; offset/length are u32 image fields at both widths.
 * Reject an entire invalid chunk before mutating the pending executable image.
 */
export function write_exec_image(
  pending: Uint8Array | null,
  kernel: WebAssembly.Memory,
  source: WasmAddress,
  offset: number,
  length: number,
): number {
  if (!pending) return -22;
  try {
    const destination = wasm_size_to_number(offset);
    const count = wasm_size_to_number(length);
    if (destination > pending.byteLength - count) return -22;
    refresh_memory_range(kernel, source, count);
    const bytes = memory_bytes(kernel, wasm_pointer_to_number(source), count);
    if (!bytes) return -22;
    pending.set(bytes, destination);
    return 0;
  } catch {
    return -22;
  }
}
