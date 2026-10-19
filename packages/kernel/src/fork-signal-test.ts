// SPDX-License-Identifier: MIT
// Private build-only test seam, never an application or boot API.
import type { Instance, WasmAddressType } from "./wasm.ts";

export const fork_signal_test = false;
export const fork_resume_signal_test = false;
export const fork_child_signal_test = false;

export function inject_saved_fork_signal(
  syscall: Instance["exports"]["syscall"],
  address: WasmAddressType,
): void {
  if (!fork_signal_test) return;
  inject_current_signal(syscall, address);
}

export function inject_resume_fork_signal(
  syscall: Instance["exports"]["syscall"],
  address: WasmAddressType,
): void {
  if (!fork_resume_signal_test) return;
  inject_current_signal(syscall, address);
}

export function inject_child_fork_signal(
  syscall: Instance["exports"]["syscall"],
  address: WasmAddressType,
): void {
  if (!fork_child_signal_test) return;
  inject_current_signal(syscall, address);
}

function inject_current_signal(
  syscall: Instance["exports"]["syscall"],
  address: WasmAddressType,
): void {
  const p = (value: number) => (address === "i64" ? BigInt(value) : value);
  const zero = p(0);
  const pid = syscall(p(172), zero, zero, zero, zero, zero, zero);
  if (
    typeof pid !== typeof zero ||
    !Number.isSafeInteger(Number(pid)) ||
    Number(pid) <= 0 ||
    Number(pid) > 0x7fffffff
  )
    throw new Error("fork signal test: invalid signal target PID");
  // Linux/Wasm's existing getpid=172, kill=129 and SIGUSR1=10.
  if (syscall(p(129), pid, p(10), zero, zero, zero, zero) !== zero)
    throw new Error("fork signal test: kill failed");
}
