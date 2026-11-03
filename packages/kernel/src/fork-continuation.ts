// SPDX-License-Identifier: MIT
// Experimental, opt-in single-thread user execution ABI. Linux still owns PIDs,
// clone admission, file inheritance, signals, exit and wait.
import {
  memory_bytes,
  wasm_pointer_to_number,
  wasm_value_to_number,
  type WasmAddress,
  type WasmAddressType,
} from "./wasm.ts";
import { clone3_fork_request, clone_fork_request, type CloneForkRequest } from "./clone3-args.ts";

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

function validFeatureBits(value: unknown): value is number {
  // This private capability is an exported C int, never a pointer or errno.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0x7fffffff;
}

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
  strict = false,
): WasmAddress {
  // No local validation, descriptor lookup or user-memory read may precede
  // kernel policy. Let the real entry kill/trace/skip the original syscall.
  if (strict) return fork ? fork.kernelCall(invoke) : invoke();
  const zero = (value: WasmAddress | undefined) => value === 0 || value === 0n;
  if (nr === 435 || nr === 435n) {
    // Only our suspended, capability-gated execution helper may call generic
    // kernel clone3 through the legacy import. Ordinary callers still enter
    // the flags-v2 continuation path and cannot bypass the admission gate.
    if (layout === "callback-v1" && fork?.nativeClone3DispatchAllowed())
      return fork.kernelCall(invoke);
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
    const result = fork?.cloneCheckpoint(args, allowed) ?? -95;
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

export function dispatch_fork_checkpoint(
  fork: ForkContinuation | null,
  descriptor: WasmAddress,
  allowed: boolean,
  invoke: () => WasmAddress,
  strict = false,
): number {
  if (strict) return Number(fork ? fork.kernelCall(invoke) : invoke());
  return fork?.checkpoint(descriptor, allowed) ?? -38;
}

export class ForkContinuation {
  private descriptor: WasmAddress | null = null;
  private result: number | null = null;
  private pidfd: WasmAddress | null = null;
  private namespaceFlags: WasmAddress | null = null;
  private sharingFlags: CloneForkRequest["sharingFlags"];
  private nativeRequest = false;
  private legacyOptions = false;
  private nativeActive = false;
  private tids: CloneForkRequest["tids"];
  private flags64 = 0n;
  private cgroup: bigint | undefined;
  private setTid: number[] | undefined;
  private kernelDepth = 0;
  private readonly userPollSupported: boolean;
  private exitSignal = 17;
  private parentFlags: WasmAddress | undefined;
  private tracingFlags: WasmAddress | undefined;
  private rewindingChild = false;
  private readonly childRewound: (() => void) | undefined;
  private readonly childReturnWork: (() => void) | undefined;
  private readonly e: WebAssembly.Exports;
  private readonly memory: WebAssembly.Memory;
  private readonly address: WasmAddressType;
  private readonly syscallAbi: number;
  private readonly pidfdSupported: boolean;
  private readonly nativeClone3Supported: boolean;

  constructor(
    instance: WebAssembly.Instance,
    memory: WebAssembly.Memory,
    address: WasmAddressType,
    childRewound?: () => void,
    pidfdSupported = false,
    nativeClone3Supported = false,
    childReturnWork?: () => void,
  ) {
    this.nativeClone3Supported = nativeClone3Supported;
    this.pidfdSupported = pidfdSupported;
    this.childRewound = childRewound;
    this.childReturnWork = childReturnWork;
    this.e = instance.exports;
    this.userPollSupported = typeof this.e.__wasm_fork_user_poll_abi === "function";
    if (this.userPollSupported) {
      this.require(
        (this.e.__wasm_fork_user_poll_abi as CallableFunction).length === 0,
        "invalid fork polling ABI signature",
      );
      this.require(this.call("__wasm_fork_user_poll_abi") === 1, "unsupported fork polling ABI");
    }
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
    return wasm_pointer_to_number(value);
  }
  private validDescriptor(value: WasmAddress): boolean {
    try {
      const word = this.address === "i64" ? 8 : 4;
      const offset = this.pointer(value);
      const bytes = memory_bytes(this.memory, offset, 2 * word);
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
        // The stack and native TLS are restored and Asyncify is idle now.
        // Unlike timing diagnostics, signal/ptrace return work is mandatory:
        // preserve fatal exit, exec and non-local handler control transfers.
        this.childReturnWork?.();
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

  cloneCheckpoint(args: WasmAddress[], allowed: boolean): number {
    if (!allowed || this.kernelDepth !== 0 || !this.syscallAbi || args.length !== 6) return -95;
    if (this.state() === 2) return this.syscallCheckpoint(allowed);
    if (this.state() !== 0 || this.descriptor !== null) return -16;
    const request = clone_fork_request(this.memory, this.address, args);
    return typeof request === "number" ? request : this.requestCheckpoint(request, allowed, false);
  }

  clone3Checkpoint(pointer: WasmAddress, size: WasmAddress, allowed: boolean): number {
    if (!allowed || this.kernelDepth !== 0 || !("__wasm_fork_syscall_abi" in this.e)) return -95;
    if (this.syscallAbi < 2) return -38;
    // A rewind finishes the already-admitted request, rather than parsing a
    // second request from memory that the saved-frame machinery may change.
    if (this.state() === 2) return this.syscallCheckpoint(allowed);
    if (this.state() !== 0 || this.descriptor !== null) return -16;
    const request = clone3_fork_request(this.memory, this.address, pointer, size);
    if (typeof request === "number") return request;
    return this.requestCheckpoint(request, allowed, true);
  }

  private requestCheckpoint(request: CloneForkRequest, allowed: boolean, clone3: boolean): number {
    const wide = typeof this.e.__wasm_fork_clone3_flags64 === "function";
    const native =
      clone3 &&
      this.nativeClone3Supported &&
      (wide || typeof this.e.__wasm_fork_clone3_native === "function");
    if (request.flags64 && (!native || !wide)) return -95;
    if (request.setTid !== undefined) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (
        !native ||
        !validFeatureBits(features) ||
        !(features & 4) ||
        typeof this.e.__wasm_fork_clone3_set_tid !== "function" ||
        typeof this.e.__wasm_fork_clone3_pid_select !== "function"
      )
        return -95;
    }
    if (request.cgroup !== undefined) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (
        !native ||
        typeof this.e.__wasm_fork_clone3_cgroup !== "function" ||
        !validFeatureBits(features) ||
        !(features & 2)
      )
        return -95;
    }
    // Older wide helpers know CLEAR_SIGHAND but must not silently omit
    // NEWTIME or encode it in legacy clone's exit signal. Check before unwind.
    if ((request.flags64 ?? 0n) & 0x80n) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (!validFeatureBits(features) || !(features & 1)) return -95;
    }
    const legacy = !clone3 && typeof this.e.__wasm_fork_clone_options === "function";
    if ((request.flags64 ?? 0n) & 0x2000000000n) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (!native || !validFeatureBits(features) || !(features & 1024)) return -95;
    }
    if (request.tracingFlags !== undefined) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      const required =
        (BigInt(request.tracingFlags) & 0x800000n ? 4096 : 0) |
        (BigInt(request.tracingFlags) & 0x2000n ? 8192 : 0);
      if ((!native && !legacy) || !validFeatureBits(features) || (features & required) !== required)
        return -95;
    }
    if (request.parentFlags !== undefined) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if ((!native && !legacy) || !validFeatureBits(features) || !(features & 512)) return -95;
    }
    if ((request.flags64 ?? 0n) & 0x1400000000n) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      const required =
        ((request.flags64 ?? 0n) & 0x400000000n ? 128 : 0) |
        ((request.flags64 ?? 0n) & 0x1000000000n ? 256 : 0);
      if (!native || !validFeatureBits(features) || (features & required) !== required) return -95;
    }
    if (request.exitSignal !== undefined) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (
        (clone3
          ? !native || typeof this.e.__wasm_fork_clone3_exit_signal !== "function"
          : !legacy || typeof this.e.__wasm_fork_clone_exit_signal !== "function") ||
        !validFeatureBits(features) ||
        !(features & (clone3 ? 64 : 16384))
      )
        return -95;
    }
    if ((request.flags64 ?? 0n) & 0x800000000n) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (!native || !validFeatureBits(features) || !(features & 32)) return -95;
    }
    if (request.sharingFlags !== undefined) {
      const features =
        typeof this.e.__wasm_fork_clone3_features === "function"
          ? this.call("__wasm_fork_clone3_features")
          : 0;
      if (
        (!native && !legacy) ||
        !validFeatureBits(features) ||
        (BigInt(request.sharingFlags) & 0x600n ? !(features & 8) : false) ||
        (BigInt(request.sharingFlags) & 0x40000n ? !(features & 16) : false) ||
        (BigInt(request.sharingFlags) & 0x80000000n ? !(features & 2048) : false)
      )
        return -95;
    }
    if (request.tids && !native && !legacy) return -95;
    if (
      !native &&
      !legacy &&
      request.namespaceFlags !== undefined &&
      typeof this.e.__wasm_fork_clone_namespaces !== "function"
    )
      return -95;
    if (
      request.pidfd !== null &&
      (!this.pidfdSupported ||
        (!native &&
          !legacy &&
          request.namespaceFlags === undefined &&
          typeof this.e.__wasm_fork_clone_pidfd !== "function"))
    )
      return -95;
    const result = this.syscallCheckpoint(allowed);
    if (result === 0) {
      this.pidfd = request.pidfd;
      this.namespaceFlags = request.namespaceFlags ?? null;
      this.sharingFlags = request.sharingFlags;
      this.nativeRequest = native;
      this.legacyOptions = legacy;
      this.tids = request.tids;
      this.flags64 = request.flags64 ?? 0n;
      this.cgroup = request.cgroup;
      this.setTid = request.setTid;
      this.exitSignal = request.exitSignal ?? 17;
      this.parentFlags = request.parentFlags;
      this.tracingFlags = request.tracingFlags;
    }
    return result;
  }

  kernelCall<T>(callback: () => T): T {
    this.kernelDepth++;
    try {
      return callback();
    } finally {
      this.kernelDepth--;
    }
  }

  userPollAllowed(insideSignal = false): boolean {
    // Stopped unwind still owns a live descriptor while clone copies memory.
    // Handler nesting is separately checked by the kernel/host callback gate.
    return (
      this.userPollSupported &&
      this.state() === 0 &&
      this.descriptor === null &&
      (this.kernelDepth === 0 || insideSignal)
    );
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
    try {
      if (this.nativeRequest) {
        this.nativeActive = true;
        if (typeof this.e.__wasm_fork_clone3_exit_signal === "function")
          this.require(
            this.call("__wasm_fork_clone3_exit_signal", this.exitSignal) === 0,
            "clone3 exit signal staging failed",
          );
        const zero = this.address === "i64" ? 0n : 0;
        const flags =
          BigInt(this.namespaceFlags ?? zero) |
          BigInt(this.sharingFlags ?? zero) |
          BigInt(this.parentFlags ?? zero) |
          BigInt(this.tracingFlags ?? zero) |
          BigInt(this.tids?.flags ?? zero) |
          this.flags64;
        if (this.setTid !== undefined) {
          this.setTid.forEach((value, index) =>
            this.require(
              this.call("__wasm_fork_clone3_set_tid", index, value) === 0,
              "PID selection staging failed",
            ),
          );
          return this.call(
            "__wasm_fork_clone3_pid_select",
            flags,
            this.pidfd ?? zero,
            this.tids?.parent ?? zero,
            this.tids?.child ?? zero,
            this.cgroup ?? 0n,
            this.setTid.length,
          );
        }
        if (this.cgroup !== undefined)
          return this.call(
            "__wasm_fork_clone3_cgroup",
            flags,
            this.pidfd ?? zero,
            this.tids?.parent ?? zero,
            this.tids?.child ?? zero,
            this.cgroup,
          );
        const wide = typeof this.e.__wasm_fork_clone3_flags64 === "function";
        return this.call(
          wide ? "__wasm_fork_clone3_flags64" : "__wasm_fork_clone3_native",
          wide || this.address === "i64" ? flags : Number(flags),
          this.pidfd ?? zero,
          this.tids?.parent ?? zero,
          this.tids?.child ?? zero,
        );
      }
      if (this.legacyOptions) {
        const zero = this.address === "i64" ? 0n : 0;
        const flags =
          BigInt(this.namespaceFlags ?? zero) |
          BigInt(this.sharingFlags ?? zero) |
          BigInt(this.parentFlags ?? zero) |
          BigInt(this.tracingFlags ?? zero) |
          BigInt(this.tids?.flags ?? zero) |
          (this.pidfd === null ? 0n : 0x1000n);
        if (this.exitSignal !== 17)
          return this.call(
            "__wasm_fork_clone_exit_signal",
            this.address === "i64" ? flags : Number(flags),
            this.pidfd ?? this.tids?.parent ?? zero,
            this.tids?.child ?? zero,
            this.exitSignal,
          );
        return this.call(
          "__wasm_fork_clone_options",
          this.address === "i64" ? flags : Number(flags),
          this.pidfd ?? this.tids?.parent ?? zero,
          this.tids?.child ?? zero,
        );
      }
      if (this.namespaceFlags !== null)
        return this.call(
          "__wasm_fork_clone_namespaces",
          this.namespaceFlags,
          this.pidfd ?? (this.address === "i64" ? 0n : 0),
        );
      return this.pidfd === null
        ? this.call("__wasm_fork_clone")
        : this.call("__wasm_fork_clone_pidfd", this.pidfd);
    } finally {
      // A negative result or trap must not leak options to a later plain fork.
      this.pidfd = null;
      this.namespaceFlags = null;
      this.sharingFlags = undefined;
      this.nativeRequest = false;
      this.legacyOptions = false;
      this.nativeActive = false;
      this.tids = undefined;
      this.flags64 = 0n;
      this.cgroup = undefined;
      this.setTid = undefined;
      this.exitSignal = 17;
      this.parentFlags = undefined;
      this.tracingFlags = undefined;
    }
  }

  nativeClone3DispatchAllowed(): boolean {
    return this.nativeActive && this.kernelDepth === 0;
  }

  nativeClone3EntryAllowed(): boolean {
    return this.nativeActive && this.kernelDepth === 1;
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
      memory_bytes(this.memory, this.pointer(snapshot.descriptor), this.address === "i64" ? 16 : 8),
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
