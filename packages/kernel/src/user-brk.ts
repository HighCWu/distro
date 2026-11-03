// SPDX-License-Identifier: MIT
import {
  memory_bytes,
  refresh_memory_range,
  wasm_pointer_to_number,
  type WasmAddress,
  type WasmAddressType,
} from "./wasm.ts";

function callbacks(exports: WebAssembly.Exports) {
  const layout = exports.__wasm_brk_layout_v1;
  const update = exports.__wasm_brk_update_v1;
  return typeof layout === "function" &&
    layout.length === 0 &&
    typeof update === "function" &&
    update.length === 1
    ? { layout, update }
    : null;
}

/** Immutable user pointer slots become fixed u64 kernel fields. No user
 * offset is dereferenced in kernel memory, and no allocator is substituted. */
export function user_brk_layout(
  exports: WebAssembly.Exports,
  user: WebAssembly.Memory,
  address: WasmAddressType,
  kernel: WebAssembly.Memory,
  destination: WasmAddress,
): number {
  const functions = callbacks(exports);
  if (!functions) return -38;
  const pointer = functions.layout() as WasmAddress;
  if (pointer === 0 || pointer === 0n) return -14;
  const size = address === "i64" ? 8 : 4;
  let source, target;
  try {
    refresh_memory_range(user, pointer, 3 * size);
    source = memory_bytes(user, wasm_pointer_to_number(pointer), 3 * size);
    refresh_memory_range(kernel, destination, 24);
    target = memory_bytes(kernel, wasm_pointer_to_number(destination), 24);
  } catch {
    return -14;
  }
  if (!source || !target) return -14;
  const input = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const fields = Array.from({ length: 3 }, (_, index) =>
    size === 8
      ? input.getBigUint64(index * size, true)
      : BigInt(input.getUint32(index * size, true)),
  );
  const output = new DataView(target.buffer, target.byteOffset, target.byteLength);
  fields.forEach((field, index) => output.setBigUint64(index * 8, field, true));
  return 0;
}

export function user_brk_update(
  exports: WebAssembly.Exports,
  address: WasmAddressType,
  requested: WasmAddress,
): WasmAddress {
  const functions = callbacks(exports);
  if (!functions) return address === "i64" ? -38n : -38;
  return functions.update(requested) as WasmAddress;
}
