// SPDX-License-Identifier: MIT

import type { WasmDylink } from "./wasm_binary.ts";

export interface DylinkArena {
  /** First unused offset and exclusive end, in bytes or table elements. */
  cursor: bigint;
  limit: bigint;
  address: "i32" | "i64";
}

/** Compute an entire batch without growing memory/table or changing an allocator.
 * The caller supplies disjoint allocator-owned arenas and dependency order. This
 * is a plan, not a reservation: it must be committed under the allocator's lock
 * before initialization, and does not establish symbol or start-section safety.
 * Memory and table widths are independent (including memory64 with table32). */
export function plan_dylink_layout(
  modules: readonly WasmDylink[],
  memory: Readonly<DylinkArena>,
  table: Readonly<DylinkArena>,
) {
  function validate(arena: Readonly<DylinkArena>) {
    const bits = arena.address === "i32" ? 32n : 64n;
    if (arena.cursor < 0n || arena.limit < arena.cursor || arena.limit > 1n << bits)
      throw new RangeError("invalid dylink arena");
  }
  validate(memory);
  validate(table);
  function area(cursor: bigint, size: number, power: number, arena: Readonly<DylinkArena>) {
    const bits = arena.address === "i32" ? 32 : 64;
    if (!Number.isInteger(size) || size < 0 || size > 0xffffffff)
      throw new RangeError("invalid dylink size");
    if (!Number.isInteger(power) || power < 0 || power >= bits)
      throw new RangeError("unsupported dylink alignment");
    const alignment = 1n << BigInt(power);
    const base = ((cursor + alignment - 1n) / alignment) * alignment;
    const end = base + BigInt(size);
    // An empty area at 2^bits still cannot be represented by a base global.
    if (base >= 1n << BigInt(bits) || end > arena.limit)
      throw new RangeError("dylink reservation capacity exceeded");
    return { base, end };
  }
  let memoryEnd = memory.cursor;
  let tableEnd = table.cursor;
  const items = modules.map((module) => {
    if (
      module.target !== undefined &&
      module.target !== `wasm${memory.address === "i32" ? 32 : 64}`
    )
      throw new RangeError("dylink target does not match process memory");
    const data = area(memoryEnd, module.memorySize, module.memoryAlignment, memory);
    const functions = area(tableEnd, module.tableSize, module.tableAlignment, table);
    memoryEnd = data.end;
    tableEnd = functions.end;
    return { base: data.base, tableBase: functions.base };
  });
  return { items, memoryEnd, tableEnd };
}
