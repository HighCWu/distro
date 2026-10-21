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
import { clone3_fork_request } from "./clone3-args.ts";

export interface ForkSnapshot {
  version: 1;
  address: WasmAddressType;
  descriptor: WasmAddress;
  stack: WasmAddress;
  tls: WasmAddress;
  entry: WasmAddress;
}

/** Scope child metadata to this clone, including negative results and traps. */
export function resume_fork_parent(
  owner: { fork_continuation?: ForkSnapshot },
  continuation: ForkContinuation,
  afterSuspend?: () => void,
  beforeParentResume?: () => void,
): void {
  owner.fork_continuation = continuation.suspend();
  let result: WasmAddress;
  try {
    afterSuspend?.();
    result = continuation.clone();
  } finally {
    delete owner.fork_continuation;
  }
  // A private test hook after successful clone, with no published snapshot
  // metadata left in the parent and before Asyncify starts rewinding.
  if (result > 0) beforeParentResume?.();
  continuation.resumeParent(result);
}

/** Private test path, invoked at user.call, never inside switch_entry. */
export function resume_fork_child(
  owner: { fork_continuation?: ForkSnapshot },
  continuation: ForkContinuation,
  beforeResume: () => void,
): void {
  const snapshot = owner.fork_continuation;
  if (!snapshot) throw new Error("missing fork child snapshot");
  try {
    beforeResume();
    continuation.resumeChild(snapshot);
  } finally {
    delete owner.fork_continuation;
  }
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
  return (
    WebAssembly.Module.imports(module).some((e) => e.module === "linux_fork_v1") ||
    WebAssembly.Module.exports(module).some((e) => e.name === "__wasm_fork_abi")
  );
}

export function fork_continuation_exports_supported(module: WebAssembly.Module): boolean {
  if (!uses_fork_continuation(module)) return true;
  const exports = WebAssembly.Module.exports(module);
  return (
    functions.every((name) => exports.some((e) => e.name === name && e.kind === "function")) &&
    globals.every((name) => exports.some((e) => e.name === name && e.kind === "global")) &&
    (!exports.some((e) => e.name === "__wasm_fork_syscall_abi") ||
      ["__wasm_fork_syscall_abi", "__wasm_fork_descriptor"].every((name) =>
        exports.some((e) => e.name === name && e.kind === "function"),
      ))
  );
}

// Linux/Wasm's existing clone ABI is (callback, argument, flags, ptid, ctid,
// tls), NOT another architecture's (flags, stack, ...) register layout. A null
// callback requests continuation at the calling syscall, not a callback task.
export type CloneSyscallLayout = "callback-v1" | "flags-v2";

export function dispatch_fork_syscall(
  fork: ForkContinuation | null,
  nr: WasmAddress,
  args: WasmAddress[],
  allowed: boolean,
  invoke: () => WasmAddress,
  layout: CloneSyscallLayout = "callback-v1",
): WasmAddress {
  const zero = (value: WasmAddress | undefined) => value === 0 || value === 0n;
  if (nr === 435 || nr === 435n) {
    // clone3 has no legacy callback layout. Never let it reach copy_thread
    // without a user continuation; the old import explicitly reports ENOSYS.
    const result =
      layout !== "flags-v2"
        ? -38
        : args.length !== 6
          ? -22
          : (fork?.clone3Checkpoint(args[0]!, args[1]!, allowed) ?? -95);
    return typeof nr === "bigint" ? BigInt(result) : result;
  }
  if ((nr === 220 || nr === 220n) && layout === "flags-v2") {
    // The import name selects the ABI. Never infer a layout from flag values
    // or from a possible function-table index. The sixth register is unused
    // by the Linux default five-argument clone ABI.
    const supported =
      args.length === 6 && (args[0] === 17 || args[0] === 17n) && args.slice(1, 5).every(zero);
    const result = supported ? (fork?.syscallCheckpoint(allowed) ?? -95) : -95;
    return typeof nr === "bigint" ? BigInt(result) : result;
  }
  if ((nr === 220 || nr === 220n) && zero(args[0])) {
    let result: number;
    if (!zero(args[1])) {
      result = -22; // EINVAL: no callback argument
    } else if (
      args.length !== 6 ||
      (args[2] !== 17 && args[2] !== 17n) ||
      args.slice(3).some((value) => !zero(value))
    ) {
      result = -95;
    } else {
      result = fork?.syscallCheckpoint(allowed) ?? -95;
    }
    return typeof nr === "bigint" ? BigInt(result) : result;
  }
  return fork ? fork.kernelCall(invoke) : invoke();
}

export class ForkContinuation {
  private descriptor: WasmAddress | null = null;
  private result: number | null = null;
  private kernelDepth = 0;
  private rewindingChild = false;
  private readonly childRewound: (() => void) | undefined;
  private readonly e: WebAssembly.Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly address: WasmAddressType;
  private readonly syscallAbi: number;

  constructor(
    instance: WebAssembly.Instance,
    memory: WebAssembly.Memory,
    address: WasmAddressType,
    childRewound?: () => void,
  ) {
    this.childRewound = childRewound;
    this.e = instance.exports;
    this.memory = memory;
    this.address = address;
    for (const name of functions)
      this.require(typeof this.e[name] === "function", `missing ${name}`);
    for (const name of globals)
      this.require(this.e[name] instanceof WebAssembly.Global, `missing ${name}`);
    this.require(this.call("__wasm_fork_abi") === 1, "unsupported ABI version");
    let syscallAbi = 0;
    if ("__wasm_fork_syscall_abi" in this.e) {
      this.require(
        typeof this.e.__wasm_fork_descriptor === "function",
        "missing syscall descriptor",
      );
      const version = this.call("__wasm_fork_syscall_abi");
      this.require(version === 1 || version === 2, "unsupported syscall ABI version");
      syscallAbi = version;
    }
    this.syscallAbi = syscallAbi;
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
    // A kernel syscall may synchronously reenter a user export (not only a
    // signal handler). Never unwind that nested call across the live kernel.
    if (!allowed || this.kernelDepth !== 0) return -95; // EOPNOTSUPP
    if (this.state() === 2) {
      this.require(
        this.descriptor === descriptor && this.result !== null,
        "unexpected rewind checkpoint",
      );
      const result = this.result;
      this.call("asyncify_stop_rewind");
      this.descriptor = null;
      this.result = null;
      if (this.rewindingChild) {
        this.rewindingChild = false;
        try {
          this.childRewound?.();
        } catch {}
      }
      return result;
    }
    // Do not unwind through a kernel call, signal trampoline or callback clone.
    if (this.state() !== 0 || this.descriptor !== null) return -16; // EBUSY
    if (!this.validDescriptor(descriptor)) return -22; // EINVAL
    this.descriptor = descriptor;
    this.call("asyncify_start_unwind", descriptor);
    return 0; // ignored by Asyncify's unwind path
  }

  syscallCheckpoint(allowed: boolean): number {
    if (!allowed || this.kernelDepth !== 0 || !("__wasm_fork_syscall_abi" in this.e)) return -95;
    // Never reset the saved-frame cursor while rewinding or while busy.
    if (this.state() === 2) {
      this.require(this.descriptor !== null, "missing syscall rewind descriptor");
      return this.checkpoint(this.descriptor, allowed);
    }
    if (this.state() !== 0 || this.descriptor !== null) return -16;
    return this.checkpoint(this.call("__wasm_fork_descriptor"), allowed);
  }

  clone3Checkpoint(pointer: WasmAddress, size: WasmAddress, allowed: boolean): number {
    if (!allowed || this.kernelDepth !== 0 || !("__wasm_fork_syscall_abi" in this.e)) return -95;
    if (this.syscallAbi < 2) return -38;
    // A rewind finishes the already-admitted request, rather than parsing a
    // second request from memory that the saved-frame machinery may change.
    if (this.state() === 2) return this.syscallCheckpoint(allowed);
    if (this.state() !== 0 || this.descriptor !== null) return -16;
    const error = clone3_fork_request(this.memory, this.address, pointer, size);
    return error || this.syscallCheckpoint(allowed);
  }

  kernelCall<T>(callback: () => T): T {
    this.kernelDepth++;
    try {
      return callback();
    } finally {
      this.kernelDepth--;
    }
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
    this.rewindingChild = true;
    this.call("asyncify_start_rewind", snapshot.descriptor);
  }
}
