// SPDX-License-Identifier: MIT

import { memory_bytes, refresh_memory, type WasmAddress, type WasmAddressType } from "./wasm.ts";

/** Experimental synchronous bridge; the kernel caller retains ownership of staging.
 * This neither reads files nor admits file mmap. No source address reaches userspace.
 */
export class FileMmapCopy {
  private active: { source: number; length: number; used: boolean } | null = null;
  private kernel_memory: WebAssembly.Memory;
  private address: WasmAddressType;

  constructor(kernel_memory: WebAssembly.Memory, address: WasmAddressType) {
    this.kernel_memory = kernel_memory;
    this.address = address;
  }

  private scalar(value: WasmAddress): number | null {
    if (this.address === "i32") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < -0x80000000 ||
        value > 0xffffffff
      )
        return null;
      return value >>> 0;
    }
    if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
      return null;
    return Number(value);
  }

  private error(errno: number): WasmAddress {
    return this.address === "i64" ? BigInt(-errno) : -errno;
  }

  /** Called only by the new kernel import, never by a user syscall argument. */
  map(
    exports: WebAssembly.Exports,
    rounded: WasmAddress,
    source: WasmAddress,
    length: WasmAddress,
  ): WasmAddress {
    if (this.active) return this.error(16); // EBUSY: no nested lease replacement
    const size = this.scalar(rounded);
    const start = this.scalar(source);
    const count = this.scalar(length);
    if (size === null || !size || size % 4096 || start === null || count === null || count > size)
      return this.error(22);
    const callback = exports.__wasm_mmap_init_v1;
    if (typeof callback !== "function") return this.error(38);
    refresh_memory(this.kernel_memory, this.address);
    if (!memory_bytes(this.kernel_memory, start, count)) return this.error(14);
    this.active = { source: start, length: count, used: false };
    try {
      return callback(rounded, length) as WasmAddress;
    } finally {
      this.active = null;
    }
  }

  /** User import: one exact copy from the active source, including a zero-byte copy. */
  copy(memory: WebAssembly.Memory, destination: WasmAddress, length: WasmAddress): number {
    const active = this.active;
    if (!active || active.used) return -1; // EPERM outside the synchronous lease
    active.used = true; // Even failed copies cannot be retried against another target.
    const start = this.scalar(destination);
    const count = this.scalar(length);
    if (start === null || count === null || count !== active.length) return -22;
    try {
      refresh_memory(this.kernel_memory, this.address);
      refresh_memory(memory, this.address);
      const from = memory_bytes(this.kernel_memory, active.source, count);
      const to = memory_bytes(memory, start, count);
      if (!from || !to) return -14;
      to.set(from);
      return 0;
    } catch {
      return -14;
    }
  }
}
