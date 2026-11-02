// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { create_dylink_forwarder } from "../src/dylink_forwarder.ts";

const provider = new WebAssembly.Instance(
  new WebAssembly.Module(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 3, 2, 1, 0, 7, 5, 1, 1, 102, 0,
      0, 10, 9, 1, 7, 0, 0x20, 0, 0x41, 2, 0x6a, 0x0b,
    ]),
  ),
).exports.f as CallableFunction;

for (const address of ["i32", "i64"] as const) {
  test(`${address}: typed forward calls trap before binding and use the canonical native target`, () => {
    const word = (n: number) => (address === "i64" ? BigInt(n) : n);
    const table = new WebAssembly.Table({
      element: "anyfunc",
      initial: word(8),
      address,
    } as unknown as WebAssembly.TableDescriptor);
    const forward = create_dylink_forwarder("[[127],[127]]", table, address);
    assert.throws(() => forward.call(40), WebAssembly.RuntimeError);
    const set = table.set as unknown as (index: number | bigint, value: CallableFunction) => void;
    set.call(table, word(3), provider);
    forward.target.value = word(3);
    assert.equal(forward.call(40), 42);
    forward.target.value = word(4);
    assert.throws(() => forward.call(40), WebAssembly.RuntimeError);
  });
}

test("unsupported reference signatures are rejected before constructing a forwarding instance", () => {
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  for (const signature of ["[[112],[]]", "[[],[111]]", "[null,[]]", '[["127"],[]]'])
    assert.throws(() => create_dylink_forwarder(signature, table, "i32"), TypeError);
});
