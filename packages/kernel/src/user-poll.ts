// SPDX-License-Identifier: MIT
import {
  call_kernel_entry,
  kernel_entry_active,
  user_callback_active,
  read_signal_stack_pointer,
} from "./signal-stack.ts";
import type { Instance, WasmAddressType } from "./wasm.ts";

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
