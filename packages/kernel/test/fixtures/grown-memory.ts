// SPDX-License-Identifier: MIT
// Deterministic model of a retained wrapper, not evidence of a browser defect.
import { allocate_shared_memory, type WasmAddressType } from "../../src/wasm.ts";
import assert from "node:assert/strict";

export function grown_memory(address: WasmAddressType) {
  const p = (n: number) => (address === "i64" ? BigInt(n) : n);
  const { memory } = allocate_shared_memory(1, 3, undefined, address);
  const getter = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!.get!;
  const grow = WebAssembly.Memory.prototype.grow as unknown as (
    delta: number | bigint,
  ) => number | bigint;
  const original = getter.call(memory) as SharedArrayBuffer;
  grow.call(memory, p(1));
  let view = original;
  let disabled = false;
  const calls: (number | bigint)[] = [];
  Object.defineProperty(memory, "buffer", { get: () => view });
  Object.defineProperty(memory, "grow", {
    value(delta: number | bigint) {
      assert.equal(delta, p(0), "refresh must never allocate and must preserve memory width");
      calls.push(delta);
      if (disabled) throw new RangeError("refresh unavailable");
      const result = grow.call(memory, delta);
      view = getter.call(memory) as SharedArrayBuffer;
      return result;
    },
  });
  return {
    memory,
    calls,
    live: () => getter.call(memory) as SharedArrayBuffer,
    stale: () => {
      view = original;
    },
    disable: () => {
      disabled = true;
    },
  };
}
