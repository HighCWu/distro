// SPDX-License-Identifier: MIT
import {
  call_kernel_entry,
  kernel_entry_active,
  user_callback_active,
  read_signal_stack_pointer,
} from "./signal-stack.ts";
import type { Instance, WasmAddress, WasmAddressType } from "./wasm.ts";

/** Per-instance readiness; never inherit an old exec or another Worker's TP. */
export function user_poll_thread(address: WasmAddressType, read: () => WasmAddress) {
  let suspended = 0;
  const global = new WebAssembly.Global(
    { value: address, mutable: true },
    address === "i64" ? 0n : 0,
  );
  const publish = (value: WasmAddress) => {
    if (!suspended) global.value = value;
  };
  return {
    global,
    publish,
    refresh: () => {
      if (!suspended) publish(read());
    },
    suspend<T>(invoke: () => T): T {
      const before = global.value;
      global.value = address === "i64" ? 0n : 0;
      suspended++;
      try {
        return invoke();
      } finally {
        suspended--;
        global.value = before;
      }
    },
  };
}

/** Required first return after a fork rewind, independent of compiler polling.
 * A live startup callback must fail rather than silently defer this work. */
export function call_fork_child_return(
  kernel: Instance["exports"],
  user: WebAssembly.Exports,
  memory: WebAssembly.Memory,
  address: WasmAddressType,
): number {
  if (user_callback_active(kernel) || kernel_entry_active(kernel)) return -16;
  return call_user_poll(kernel, user, memory, address, false);
}

export function fork_child_return_supported(kernel: WebAssembly.Exports): boolean {
  return (
    typeof kernel.user_poll_v1 === "function" &&
    kernel.user_poll_v1.length === 0 &&
    typeof kernel.user_context_v1 === "function" &&
    kernel.user_context_v1.length === 1
  );
}

/** Private compiler execution entry. It never manufactures a Linux syscall. */
export function call_user_poll(
  kernel: Instance["exports"],
  user: WebAssembly.Exports,
  memory: WebAssembly.Memory,
  address: WasmAddressType,
  blocked: boolean,
  inside_signal = false,
): number {
  if (blocked) return call_user_maintenance(kernel, address);
  if (user_callback_active(kernel)) return 0;
  if (kernel_entry_active(kernel)) {
    const nested = kernel.user_poll_nested_v1;
    if (!inside_signal || typeof nested !== "function" || nested.length !== 0 || nested() !== 1)
      return 0;
  }
  if (typeof kernel.user_poll_v1 !== "function" || kernel.user_poll_v1.length !== 0) return -95;
  if (typeof kernel.user_context_v1 !== "function" || kernel.user_context_v1(2) !== 1) return -11;
  if (read_signal_stack_pointer(user, memory, address) === null) return -14;
  const result: unknown = call_kernel_entry(kernel, address, () => kernel.user_poll_v1!());
  if (typeof result !== "number" || !Number.isInteger(result) || result !== (result | 0))
    throw new Error("invalid user poll execution ABI result");
  return result;
}

/** Private kernel maintenance for blocked loader operations and bounded waits.
 * It never enters user code or inspects the user's signal stack. */
export function call_user_maintenance(
  kernel: Instance["exports"],
  address: WasmAddressType,
  allowScheduling = true,
): number {
  if (user_callback_active(kernel) || kernel_entry_active(kernel)) return 0;
  if (typeof kernel.user_context_v1 !== "function") return 0;
  const in_user_context: unknown = kernel.user_context_v1(2);
  if (in_user_context !== 0 && in_user_context !== 1)
    throw new Error("invalid user context execution ABI");
  if (in_user_context !== 1) return 0;

  const maintenanceV2 = kernel.user_maintenance_v2;
  if (maintenanceV2 !== undefined) {
    if (typeof maintenanceV2 !== "function" || maintenanceV2.length !== 1)
      throw new Error("invalid user maintenance v2 execution ABI");
    const result: unknown = call_kernel_entry(kernel, address, () =>
      maintenanceV2(allowScheduling ? 1 : 0),
    );
    if (typeof result !== "number" || !Number.isInteger(result) || result !== (result | 0))
      throw new Error("invalid user maintenance execution ABI result");
    return result;
  }

  // Older kernels have only the scheduling-capable maintenance entry. It does
  // not enter user code, so it is also safe while a writer waits for receivers.
  if (!allowScheduling) return 0;
  const maintenance = kernel.user_maintenance_v1;
  if (maintenance === undefined) return 0; // Older kernels keep deferring maintenance.
  if (typeof maintenance !== "function" || maintenance.length !== 0)
    throw new Error("invalid user maintenance v1 execution ABI");
  const result: unknown = call_kernel_entry(kernel, address, () => maintenance());
  if (typeof result !== "number" || !Number.isInteger(result) || result !== (result | 0))
    throw new Error("invalid user maintenance execution ABI result");
  return result;
}
