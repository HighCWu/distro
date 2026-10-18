// SPDX-License-Identifier: MIT
// Experimental, opt-in single-thread user execution ABI. Linux still owns PIDs,
// clone admission, file inheritance, signals, exit and wait.
import {
  memory_bytes,
  wasm_address_to_number,
  wasm_value_to_number,
  type WasmAddress,
  type WasmAddressType,
} from "./wasm.ts";

export interface ForkSnapshot {
  version: 1;
  address: WasmAddressType;
  descriptor: WasmAddress;
  stack: WasmAddress;
  tls: WasmAddress;
  entry: WasmAddress;
}

const functions = [
  "_start",
  "__wasm_fork_abi",
  "__wasm_fork_child_entry",
  "__wasm_fork_clone",
  "asyncify_get_state",
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
];
const globals = ["__stack_pointer", "__tls_base"];

export function uses_fork_continuation(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some((e) => e.module === "linux_fork_v1");
}

export function fork_continuation_exports_supported(module: WebAssembly.Module): boolean {
  if (!uses_fork_continuation(module)) return true;
  const exports = WebAssembly.Module.exports(module);
  return (
    functions.every((name) => exports.some((e) => e.name === name && e.kind === "function")) &&
    globals.every((name) => exports.some((e) => e.name === name && e.kind === "global"))
  );
}

export class ForkContinuation {
  private descriptor: WasmAddress | null = null;
  private result: number | null = null;
  private readonly e: WebAssembly.Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly address: WasmAddressType;

  constructor(
    instance: WebAssembly.Instance,
    memory: WebAssembly.Memory,
    address: WasmAddressType,
  ) {
    this.e = instance.exports;
    this.memory = memory;
    this.address = address;
    for (const name of functions)
      this.require(typeof this.e[name] === "function", `missing ${name}`);
    for (const name of globals)
      this.require(this.e[name] instanceof WebAssembly.Global, `missing ${name}`);
    this.require(this.call("__wasm_fork_abi") === 1, "unsupported ABI version");
    this.require(this.state() === 0, "instance is not idle");
    this.pointer(this.global("__stack_pointer").value);
    this.pointer(this.global("__tls_base").value);
  }

  private require(value: unknown, message: string): asserts value {
    if (!value) throw new Error(`fork continuation: ${message}`);
  }
  private call(name: string, ...args: WasmAddress[]): WasmAddress {
    return (this.e[name] as CallableFunction)(...args) as WasmAddress;
  }
  private global(name: string): WebAssembly.Global {
    return this.e[name] as WebAssembly.Global;
  }
  private state(): WasmAddress {
    return this.call("asyncify_get_state");
  }
  private pointer(value: WasmAddress): number {
    this.require(
      typeof value === (this.address === "i64" ? "bigint" : "number"),
      "pointer width mismatch",
    );
    return wasm_address_to_number(value, "fork continuation pointer");
  }
  private validDescriptor(value: WasmAddress): boolean {
    try {
      const word = this.address === "i64" ? 8 : 4;
      const offset = this.pointer(value);
      const bytes = memory_bytes(this.memory, value, 2 * word);
      if (!bytes || offset % word) return false;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const start = word === 8 ? Number(view.getBigUint64(0, true)) : view.getUint32(0, true);
      const end = word === 8 ? Number(view.getBigUint64(word, true)) : view.getUint32(word, true);
      return (
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start % word === 0 &&
        end % word === 0 &&
        end > start &&
        end - start <= 1024 * 1024 &&
        end <= this.memory.buffer.byteLength &&
        (end <= offset || start >= offset + 2 * word)
      );
    } catch {
      return false;
    }
  }

  checkpoint(descriptor: WasmAddress, allowed: boolean): number {
    if (this.state() === 2) {
      this.require(
        this.descriptor === descriptor && this.result !== null,
        "unexpected rewind checkpoint",
      );
      const result = this.result;
      this.call("asyncify_stop_rewind");
      this.descriptor = null;
      this.result = null;
      return result;
    }
    // Do not unwind through a kernel call, signal trampoline or callback clone.
    if (!allowed) return -95; // EOPNOTSUPP
    if (this.state() !== 0 || this.descriptor !== null) return -16; // EBUSY
    if (!this.validDescriptor(descriptor)) return -22; // EINVAL
    this.descriptor = descriptor;
    this.call("asyncify_start_unwind", descriptor);
    return 0; // ignored by Asyncify's unwind path
  }

  unwinding(): boolean {
    return this.descriptor !== null && this.state() === 1;
  }

  suspend(): ForkSnapshot {
    this.require(this.unwinding(), "no completed unwind");
    this.call("asyncify_stop_unwind");
    const entry = this.call("__wasm_fork_child_entry");
    this.require(this.pointer(entry) > 0, "invalid child entry");
    return {
      version: 1,
      address: this.address,
      descriptor: this.descriptor!,
      stack: this.global("__stack_pointer").value,
      tls: this.global("__tls_base").value,
      entry,
    };
  }

  clone(): WasmAddress {
    this.require(this.state() === 0 && this.descriptor !== null, "clone before unwind completed");
    return this.call("__wasm_fork_clone");
  }

  resumeParent(value: WasmAddress): void {
    const result = wasm_value_to_number(value, "clone result");
    this.require(
      Number.isInteger(result) && result >= -4095 && result <= 0x7fffffff && result !== 0,
      "invalid parent clone result",
    );
    this.require(this.state() === 0 && this.descriptor !== null, "parent is not suspended");
    this.result = result;
    this.call("asyncify_start_rewind", this.descriptor);
  }

  resumeChild(snapshot: ForkSnapshot): void {
    this.require(
      snapshot.version === 1 && snapshot.address === this.address,
      "snapshot ABI mismatch",
    );
    this.require(this.state() === 0 && this.descriptor === null, "child is not fresh");
    // The saved descriptor cursor is now at the END of the recorded frames;
    // validate scalar addresses, not the fresh descriptor's start < end rule.
    for (const value of [snapshot.descriptor, snapshot.stack, snapshot.tls, snapshot.entry])
      this.pointer(value);
    this.require(
      memory_bytes(this.memory, snapshot.descriptor, this.address === "i64" ? 16 : 8),
      "invalid inherited descriptor",
    );
    this.global("__stack_pointer").value = snapshot.stack;
    this.global("__tls_base").value = snapshot.tls;
    this.descriptor = snapshot.descriptor;
    this.result = 0;
    this.call("asyncify_start_rewind", snapshot.descriptor);
  }
}
