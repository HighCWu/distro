// SPDX-License-Identifier: MIT

import type { CloneSyscallLayout } from "./fork-continuation.ts";
import type { UserContext, WasmAddress, WasmAddressType } from "./wasm.ts";

// One shared word arbitrates the loader against callback-thread creation.
// -1 means the process loader has been claimed. Nonnegative values use bit 30
// as the permanent "a thread succeeded" bit and the low 30 bits as concurrent
// clone claims. A failed first clone therefore cannot erase a second clone's
// in-flight or successful claim.
export const DYNAMIC_LOADER_CLAIMED = -1;
export const DYNAMIC_THREAD_SUCCESS = 0x40000000;
export const DYNAMIC_THREAD_COUNT_MASK = 0x3fffffff;

const CLONE_VM = 0x00000100n;
const CLONE_THREAD = 0x00010000n;
const EAGAIN = 11;
const EOPNOTSUPP = 95;

export function create_dynamic_process_state(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

function state_word(state: SharedArrayBuffer | undefined): Int32Array | null {
  if (
    typeof SharedArrayBuffer === "undefined" ||
    !(state instanceof SharedArrayBuffer) ||
    state.byteLength !== Int32Array.BYTES_PER_ELEMENT
  )
    return null;
  return new Int32Array(state);
}

export function dynamic_process_value(state: SharedArrayBuffer | undefined): number | null {
  const word = state_word(state);
  return word ? Atomics.load(word, 0) : null;
}

export function dynamic_process_is_pristine(state: SharedArrayBuffer | undefined): boolean {
  return dynamic_process_value(state) === 0;
}

export function dynamic_process_is_threaded(state: SharedArrayBuffer | undefined): boolean {
  const value = dynamic_process_value(state);
  return value !== null && value >= 0 && (value & DYNAMIC_THREAD_SUCCESS) !== 0;
}

/** Claim loader ownership before constructing ProcessDylink or touching a table. */
export function claim_dynamic_loader(state: SharedArrayBuffer | undefined): boolean {
  const word = state_word(state);
  return word !== null && Atomics.compareExchange(word, 0, 0, DYNAMIC_LOADER_CLAIMED) === 0;
}

function claim_dynamic_thread(
  state: SharedArrayBuffer | undefined,
): { word: Int32Array; error: 0 } | { word: null; error: number } {
  const word = state_word(state);
  if (!word) return { word: null, error: EOPNOTSUPP };

  for (;;) {
    const current = Atomics.load(word, 0);
    if (current < 0) return { word: null, error: EOPNOTSUPP }; // The loader won or is initializing.
    const count = current & DYNAMIC_THREAD_COUNT_MASK;
    if (count === DYNAMIC_THREAD_COUNT_MASK) return { word: null, error: EAGAIN };
    if (Atomics.compareExchange(word, 0, current, current + 1) === current)
      return { word, error: 0 };
  }
}

function finish_dynamic_thread(word: Int32Array, succeededOrUnknown: boolean): void {
  if (succeededOrUnknown) Atomics.or(word, 0, DYNAMIC_THREAD_SUCCESS);
  Atomics.sub(word, 0, 1);
}

/**
 * Run one eligible kernel clone under a shared claim. Negative kernel results
 * release only this claim; a success or unknown throw permanently blocks the
 * loader because the kernel may already have published a child.
 */
export function run_dynamic_thread_clone(
  state: SharedArrayBuffer | undefined,
  address: WasmAddressType,
  invoke: () => WasmAddress,
): WasmAddress {
  const claim = claim_dynamic_thread(state);
  if (!claim.word) return address === "i64" ? -BigInt(claim.error) : -claim.error;
  const word = claim.word;

  let result: WasmAddress;
  try {
    result = invoke();
  } catch (error) {
    finish_dynamic_thread(word, true);
    throw error;
  }

  const failed = typeof result === "bigint" ? result < 0n : result < 0;
  if (failed) {
    finish_dynamic_thread(word, false);
  } else {
    finish_dynamic_thread(word, true);
  }
  return result;
}

/**
 * Gate for the Linux/Wasm callback-v1 pthread clone ABI. Other flag bits and
 * pointer arguments are left for the real kernel to validate.
 */
export function dynamic_thread_clone_allowed({
  context,
  layout,
  number,
  args,
  signalDepth,
  callEntryIsNormal,
  dynamicOperationDepth,
  vforkPending,
  sharedMemory,
}: {
  context: UserContext | null;
  layout: CloneSyscallLayout;
  number: WasmAddress;
  args: readonly WasmAddress[];
  signalDepth: number;
  callEntryIsNormal: boolean;
  dynamicOperationDepth: number;
  vforkPending: boolean;
  sharedMemory: boolean;
}): boolean {
  if (
    !context?.dynamic ||
    context.dynamic.vfork_child ||
    !sharedMemory ||
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
  const width = context.address === "i64" ? 64 : 32;
  const flagBits = BigInt.asUintN(width, BigInt(flags));
  return (flagBits & (CLONE_VM | CLONE_THREAD)) === (CLONE_VM | CLONE_THREAD);
}
