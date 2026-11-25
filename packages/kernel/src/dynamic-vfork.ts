// SPDX-License-Identifier: MIT

import type { CloneSyscallLayout } from "./fork-continuation.ts";
import type { DylinkWorkerSnapshot } from "./dylink_process_worker.ts";
import { DYNAMIC_LOADER_CLAIMED, dynamic_process_value } from "./dynamic-thread.ts";
import type { UserContext, WasmAddress } from "./wasm.ts";

const CLONE_VM_VFORK_SIGCHLD = 0x4111;

const is_zero = (value: WasmAddress | undefined) => value === 0 || value === 0n;

/** Admit only the callback clone shape used by a single-threaded dynamic main's
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

  if (
    context.dynamic.worker_membership !== undefined ||
    context.dynamic.worker_publication !== undefined
  )
    return false;
  const state = dynamic_process_value(context.dynamic.process_state);
  if (loaderCreated ? state !== DYNAMIC_LOADER_CLAIMED : state !== 0) return false;

  // args[1] is the callback's opaque argument, not a pointer format we own.
  return true;
}

/** A vfork replay shares its suspended parent's memory without joining a cohort. */
export function dynamic_vfork_replay_allowed(context: UserContext | null | undefined): boolean {
  const dynamic = context?.dynamic;
  return (
    dynamic?.vfork_child === true &&
    dynamic.worker_snapshot !== undefined &&
    dynamic.worker_membership === undefined &&
    dynamic.worker_publication === undefined &&
    dynamic_process_value(dynamic.process_state) === DYNAMIC_LOADER_CLAIMED
  );
}

/** Marks a vfork child only on the context copy handed to its new Worker. */
export function dynamic_vfork_context(
  context: UserContext | null,
  pending: boolean,
  snapshot?: DylinkWorkerSnapshot,
): UserContext | null {
  if (!pending || !context?.dynamic || context.dynamic.vfork_child) return context;
  return {
    ...context,
    dynamic: {
      ...context.dynamic,
      ...(snapshot ? { worker_snapshot: snapshot } : {}),
      vfork_child: true,
    },
  };
}

/** Keeps the parent marker scoped to the synchronous kernel clone operation. */
export class DynamicVforkState {
  #pending = false;
  #snapshot: DylinkWorkerSnapshot | undefined;

  get pending() {
    return this.#pending;
  }

  blocked(context: UserContext | null) {
    return this.#pending || context?.dynamic?.vfork_child === true;
  }

  context(context: UserContext | null) {
    return dynamic_vfork_context(context, this.#pending, this.#snapshot);
  }

  run<T>(invoke: () => T, snapshot?: DylinkWorkerSnapshot): T {
    this.#pending = true;
    this.#snapshot = snapshot;
    try {
      return invoke();
    } finally {
      this.#pending = false;
      this.#snapshot = undefined;
    }
  }
}
