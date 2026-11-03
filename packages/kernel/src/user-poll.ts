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
  if (blocked || user_callback_active(kernel)) return 0;
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
