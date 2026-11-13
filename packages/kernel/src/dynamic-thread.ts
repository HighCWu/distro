// SPDX-License-Identifier: MIT

import type { CloneSyscallLayout } from "./fork-continuation.ts";
import {
  wasm_address_from_number,
  wasm_address_to_number,
  wasm_table_get,
  type UserContext,
  type WasmAddress,
  type WasmAddressType,
} from "./wasm.ts";

// One shared word arbitrates the loader against callback-thread creation.
// -1 means the process loader has been claimed. Bit 29 marks a published,
// immutable replay snapshot; bit 30 means a thread has succeeded. The low 29
// bits count concurrent clone claims. A failed replay-backed clone can return
// the loader to -1 only after the last claim fails and no sibling succeeded.
export const DYNAMIC_LOADER_CLAIMED = -1;
export const DYNAMIC_REPLAY_READY = 0x20000000;
export const DYNAMIC_THREAD_SUCCESS = 0x40000000;
export const DYNAMIC_THREAD_COUNT_MASK = 0x1fffffff;

const CLONE_VM = 0x00000100n;
const CLONE_THREAD = 0x00010000n;
const EAGAIN = 11;
const EOPNOTSUPP = 95;

export interface DynamicTableSnapshot {
  length: number;
  slots: Array<CallableFunction | null>;
}

/** Snapshot a bounded JS-visible table using the index width of its ABI. */
export function snapshot_dynamic_table(
  table: WebAssembly.Table,
  address: WasmAddressType,
): DynamicTableSnapshot {
  const length = wasm_address_to_number(table.length as unknown as WasmAddress, "table length");
  const slots = new Array<CallableFunction | null>(length);
  for (let index = 0; index < length; index++)
    slots[index] = wasm_table_get(table, wasm_address_from_number(index, address));
  return { length, slots };
}

/** Restore a table snapshot without narrowing a table64 index to Number. */
export function restore_dynamic_table(
  table: WebAssembly.Table,
  address: WasmAddressType,
  snapshot: DynamicTableSnapshot,
): void {
  const length = wasm_address_to_number(table.length as unknown as WasmAddress, "table length");
  if (length < snapshot.length) throw new Error("dynamic loader constructor shrank the main table");
  const set = table.set as unknown as (index: WasmAddress, value: CallableFunction | null) => void;
  for (let index = snapshot.length; index < length; index++)
    set.call(table, wasm_address_from_number(index, address), null);
  for (let index = 0; index < snapshot.length; index++)
    set.call(table, wasm_address_from_number(index, address), snapshot.slots[index] ?? null);
}

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

export function dynamic_process_has_replay(state: SharedArrayBuffer | undefined): boolean {
  const value = dynamic_process_value(state);
  return value !== null && value >= 0 && (value & DYNAMIC_REPLAY_READY) !== 0;
}

/** Publish the immutable loader snapshot before admitting a replay-backed clone. */
export function publish_dynamic_replay_ready(state: SharedArrayBuffer | undefined): boolean {
  const word = state_word(state);
  if (!word) return false;
  for (;;) {
    const current = Atomics.load(word, 0);
    if (current >= 0 && (current & DYNAMIC_REPLAY_READY) !== 0) return true;
    if (current !== DYNAMIC_LOADER_CLAIMED) return false;
    if (
      Atomics.compareExchange(word, 0, DYNAMIC_LOADER_CLAIMED, DYNAMIC_REPLAY_READY) ===
      DYNAMIC_LOADER_CLAIMED
    )
      return true;
  }
}

/** Claim loader ownership before constructing ProcessDylink or touching a table. */
export function claim_dynamic_loader(state: SharedArrayBuffer | undefined): boolean {
  const word = state_word(state);
  return word !== null && Atomics.compareExchange(word, 0, 0, DYNAMIC_LOADER_CLAIMED) === 0;
}

/** Release only the loader claim held by the caller. The compare-exchange is
 * important: another path may have published replay state after the claim. */
export function release_dynamic_loader_claim(state: SharedArrayBuffer | undefined): boolean {
  const word = state_word(state);
  return (
    word !== null &&
    Atomics.compareExchange(word, 0, DYNAMIC_LOADER_CLAIMED, 0) === DYNAMIC_LOADER_CLAIMED
  );
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
  const previous = Atomics.sub(word, 0, 1);
  if (
    !succeededOrUnknown &&
    (previous & DYNAMIC_THREAD_SUCCESS) === 0 &&
    (previous & DYNAMIC_REPLAY_READY) !== 0 &&
    (previous & DYNAMIC_THREAD_COUNT_MASK) === 1
  ) {
    // Another clone may claim the published snapshot between the decrement and
    // this CAS. In that case it owns the replay-ready state and must finish it.
    Atomics.compareExchange(word, 0, DYNAMIC_REPLAY_READY, DYNAMIC_LOADER_CLAIMED);
  }
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
