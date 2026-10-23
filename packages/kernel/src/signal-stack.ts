// SPDX-License-Identifier: MIT
import {
  wasm_address_from_number,
  wasm_pointer_to_number,
  wasm_size_to_number,
  refresh_memory,
  type WasmAddress,
  type WasmAddressType,
} from "./wasm.ts";

// Engine import matching validates both mutability and the exact integer type;
// typeof(global.value) alone cannot distinguish an i32 stack from an f64 global.
const probes = Object.fromEntries(
  (["i32", "i64"] as const).map((type) => [
    type,
    new WebAssembly.Module(
      new Uint8Array([
        0,
        97,
        115,
        109,
        1,
        0,
        0,
        0,
        2,
        8,
        1,
        1,
        101,
        1,
        115,
        3,
        type === "i32" ? 0x7f : 0x7e,
        1,
      ]),
    ),
  ]),
) as Record<WasmAddressType, WebAssembly.Module>;
const checked = {
  i32: new WeakMap<WebAssembly.Global, boolean>(),
  i64: new WeakMap<WebAssembly.Global, boolean>(),
};

function stack_global(
  exports: WebAssembly.Exports,
  address: WasmAddressType,
): WebAssembly.Global | null {
  const global = exports.__stack_pointer;
  if (!(global instanceof WebAssembly.Global)) return null;
  let valid = checked[address].get(global);
  if (valid === undefined) {
    try {
      new WebAssembly.Instance(probes[address], { e: { s: global } });
      valid = true;
    } catch {
      valid = false;
    }
    checked[address].set(global, valid);
  }
  return valid ? global : null;
}

function memory_limit(
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  required: number,
): number {
  if (required > memory.buffer.byteLength) {
    // A remote isolate may have grown shared memory while Chromium retained
    // this isolate's old fixed-length wrapper. Never grow its actual size here.
    try {
      refresh_memory(memory, address);
    } catch {
      /* Invalid/unavailable memory still refuses below. */
    }
  }
  return memory.buffer.byteLength;
}

export function read_signal_stack_pointer(
  exports: WebAssembly.Exports,
  memory: WebAssembly.Memory,
  address: WasmAddressType,
): WasmAddress | null {
  const global = stack_global(exports, address);
  if (!global) return null;
  try {
    const raw = global.value as WasmAddress;
    const offset = wasm_pointer_to_number(raw);
    return offset <= memory_limit(memory, address, offset) ? raw : null;
  } catch {
    return null;
  }
}

/** Engine exceptions unwind Wasm call frames, not the linear C stack global.
 * Reset a kernel invocation only when it exits non-locally; a user's eventual
 * SjLj catchpad owns restoration of its separate user stack. */
export function call_kernel_entry<T>(
  exports: WebAssembly.Exports,
  address: WasmAddressType,
  invoke: () => T,
): T {
  const global = stack_global(exports, address);
  if (!global) return invoke(); // Older kernel blobs retain their existing ABI.
  const saved = global.value;
  try {
    return invoke();
  } catch (error) {
    global.value = saved;
    throw error;
  }
}

/** Retire one signal frame before a non-local exception reaches its catchpad.
 * A task which exited already handed its CPU away; it must not re-enter C. */
export function call_signal_callback<T>(invoke: () => T, cleanup: () => void, halt: symbol): T {
  let exited = false;
  try {
    return invoke();
  } catch (error) {
    exited = error === halt;
    throw error;
  } finally {
    if (!exited) cleanup();
  }
}

/** Version 1 flags: bit 0 selects siginfo (owned by the caller), bit 1 switches
 * the C linear stack. Never translate an engine exception into a Linux errno:
 * SjLj must unwind to the compiler's original catchpad. */
export function call_on_signal_stack(
  exports: WebAssembly.Exports,
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  sp: WasmAddress,
  base: WasmAddress,
  size: WasmAddress,
  flags: number,
  invoke: () => number,
): number {
  if (flags & ~3) return -22;
  if (!(flags & 2)) return invoke(); // Old modules retain ordinary callbacks.
  const global = stack_global(exports, address);
  if (!global) return -95;
  let top: number;
  try {
    top = wasm_pointer_to_number(sp);
    const start = wasm_pointer_to_number(base),
      length = wasm_size_to_number(size);
    const end = start + length;
    if (!Number.isSafeInteger(end)) return -14;
    const available = memory_limit(memory, address, end);
    if (
      !start ||
      !length ||
      length > available ||
      start > available - length ||
      top <= start ||
      top > start + length ||
      top % 16 !== 0
    )
      return -14;
  } catch {
    return -14;
  }
  const saved = global.value;
  global.value = wasm_address_from_number(top, address);
  try {
    return invoke();
  } finally {
    // Restore this instance, never a replacement image installed by exec.
    // A non-local exit's enclosing compiler catchpad restores its own SP next.
    global.value = saved;
  }
}
