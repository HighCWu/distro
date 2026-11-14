// SPDX-License-Identifier: MIT

import type { CloneSyscallLayout } from "./fork-continuation.ts";
import {
  prepare_dylink_worker_snapshot,
  type DylinkWorkerSnapshot,
} from "./dylink_process_worker.ts";
import { claim_dynamic_loader, create_dynamic_process_state } from "./dynamic-thread.ts";
import type { UserContext, WasmAddress } from "./wasm.ts";

const CLONE_VM = 0x00000100n;
const CLONE_VFORK = 0x00004000n;
const CLONE_THREAD = 0x00010000n;

/**
 * Admit only callback-v1 private-memory process copies. The callback address
 * is checked for null but remains opaque; Linux validates all remaining clone
 * flags and pointer arguments.
 */
export function dynamic_process_copy_allowed({
  context,
  layout,
  number,
  args,
  signalDepth,
  callEntryIsNormal,
  dynamicOperationDepth,
  vforkPending,
}: {
  context: UserContext | null;
  layout: CloneSyscallLayout;
  number: WasmAddress;
  args: readonly WasmAddress[];
  signalDepth: number;
  callEntryIsNormal: boolean;
  dynamicOperationDepth: number;
  vforkPending: boolean;
}): boolean {
  if (
    !context?.dynamic ||
    context.dynamic.vfork_child ||
    layout !== "callback-v1" ||
    (number !== 220 && number !== 220n) ||
    args.length !== 6 ||
    args[0] === 0 ||
    args[0] === 0n ||
    signalDepth !== 0 ||
    !callEntryIsNormal ||
    dynamicOperationDepth !== 0 ||
    vforkPending
  )
    return false;

  const flags = args[2];
  if (flags === undefined) return false;
  let flagBits: bigint;
  try {
    flagBits = BigInt.asUintN(context.address === "i64" ? 64 : 32, BigInt(flags));
  } catch {
    return false;
  }
  return (flagBits & (CLONE_VM | CLONE_THREAD | CLONE_VFORK)) === 0n;
}

/**
 * Construct the JS metadata for a private-memory process-copy child. The
 * kernel's COPY path supplies its private linear memory after this context is
 * selected. No callback, kernel entry, or user code runs here.
 */
export function create_dynamic_process_copy_context(
  parent: UserContext,
  snapshot?: DylinkWorkerSnapshot,
): UserContext {
  const parentDynamic = parent.dynamic;
  if (!parentDynamic) throw new TypeError("dynamic process copy requires a dynamic parent");

  const workerSnapshot =
    snapshot === undefined ? undefined : prepare_dylink_worker_snapshot(snapshot);
  if (
    workerSnapshot &&
    (workerSnapshot.address !== parent.address ||
      workerSnapshot.tableAddress !== parentDynamic.table.address)
  )
    throw new TypeError("dynamic process copy snapshot ABI does not match its parent");

  const processState = create_dynamic_process_state();
  if (workerSnapshot && !claim_dynamic_loader(processState))
    throw new Error("cannot claim a newly-created dynamic process state");

  return {
    ...parent,
    dynamic: {
      table: { ...parentDynamic.table },
      signatures: new Map(parentDynamic.signatures),
      tagSignatures: new Map(parentDynamic.tagSignatures),
      functionMetadata: new Map(
        [...parentDynamic.functionMetadata].map(([name, metadata]) => [name, { ...metadata }]),
      ),
      privateExports: new Set(parentDynamic.privateExports),
      process_state: processState,
      ...(workerSnapshot === undefined ? {} : { worker_snapshot: workerSnapshot }),
    },
  };
}
