// SPDX-License-Identifier: MIT

import type { CloneSyscallLayout } from "./fork-continuation.ts";
import type { UserContext, WasmAddress } from "./wasm.ts";

const CLONE_VM_VFORK_SIGCHLD = 0x4111;

const is_zero = (value: WasmAddress | undefined) => value === 0 || value === 0n;

/** Admit only the callback clone shape used by a pristine dynamic main's
 * posix_spawn path. The callback argument is opaque and must not be decoded. */
export function dynamic_vfork_allowed({
  context,
  loaderCreated,
  layout,
  number,
  args,
  signalDepth,
  callEntryIsStart,
  dynamicOperationDepth,
  pending,
}: {
  context: UserContext | null;
  loaderCreated: boolean;
  layout: CloneSyscallLayout;
  number: WasmAddress;
  args: readonly WasmAddress[];
  signalDepth: number;
  callEntryIsStart: boolean;
  dynamicOperationDepth: number;
  pending: boolean;
}): boolean {
  if (
    !context?.dynamic ||
    context.dynamic.vfork_child ||
    loaderCreated ||
    pending ||
    layout !== "callback-v1" ||
    (number !== 220 && number !== 220n) ||
    args.length !== 6 ||
    is_zero(args[0]) ||
    (args[2] !== CLONE_VM_VFORK_SIGCHLD && args[2] !== BigInt(CLONE_VM_VFORK_SIGCHLD)) ||
    !args.slice(3).every(is_zero) ||
    signalDepth !== 0 ||
    !callEntryIsStart ||
    dynamicOperationDepth !== 0
  )
    return false;

  // args[1] is the callback's opaque argument, not a pointer format we own.
  return true;
}

/** Marks a vfork child only on the context copy handed to its new Worker. */
export function dynamic_vfork_context(
  context: UserContext | null,
  pending: boolean,
): UserContext | null {
  if (!pending || !context?.dynamic || context.dynamic.vfork_child) return context;
  return { ...context, dynamic: { ...context.dynamic, vfork_child: true } };
}

/** Keeps the parent marker scoped to the synchronous kernel clone operation. */
export class DynamicVforkState {
  #pending = false;

  get pending() {
    return this.#pending;
  }

  blocked(context: UserContext | null) {
    return this.#pending || context?.dynamic?.vfork_child === true;
  }

  context(context: UserContext | null) {
    return dynamic_vfork_context(context, this.#pending);
  }

  run<T>(invoke: () => T): T {
    this.#pending = true;
    try {
      return invoke();
    } finally {
      this.#pending = false;
    }
  }
}
