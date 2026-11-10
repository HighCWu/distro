// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  DynamicVforkState,
  dynamic_vfork_allowed,
  dynamic_vfork_context,
} from "../src/dynamic-vfork.ts";
import type { UserContext, WasmAddress } from "../src/wasm.ts";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));

function context(address: "i32" | "i64", vforkChild = false): UserContext {
  const memory = {} as WebAssembly.Memory;
  return {
    module,
    memory,
    address,
    maximum_pages: 8,
    dynamic: {
      table: { address, minimum: 4n },
      signatures: new Map([["main", "signature"]]),
      tagSignatures: new Map([["tag", "tag-signature"]]),
      functionMetadata: new Map([["main", { signature: "signature", imported: false }]]),
      privateExports: new Set(["private"]),
      ...(vforkChild ? { vfork_child: true } : {}),
    },
  };
}

for (const address of ["i32", "i64"] as const) {
  const word = (value: number): WasmAddress => (address === "i64" ? BigInt(value) : value);
  const candidate = (overrides: Partial<Parameters<typeof dynamic_vfork_allowed>[0]> = {}) => {
    const parent = context(address);
    return dynamic_vfork_allowed({
      context: parent,
      loaderCreated: false,
      layout: "callback-v1",
      number: word(220),
      args: [
        word(0x1234),
        address === "i64" ? 0x1_0000_0000_1234n : 0xffff_ffff,
        word(0x4111),
        word(0),
        word(0),
        word(0),
      ],
      signalDepth: 0,
      callEntryIsStart: true,
      dynamicOperationDepth: 0,
      pending: false,
      ...overrides,
    });
  };

  test(`${address}: admits only the exact pristine callback-vfork clone`, () => {
    assert.equal(candidate(), true);

    const zeroArgument = [word(0x1234), word(0), word(0x4111), word(0), word(0), word(0)];
    assert.equal(candidate({ args: zeroArgument }), true, "opaque callback arg may be null");

    for (const args of [
      [word(0), word(0), word(0x4111), word(0), word(0), word(0)],
      [word(1), word(0), word(0x4110), word(0), word(0), word(0)],
      [word(1), word(0), word(0x4113), word(0), word(0), word(0)],
      [word(1), word(0), word(0x4111), word(1), word(0), word(0)],
      [word(1), word(0), word(0x4111), word(0), word(1), word(0)],
      [word(1), word(0), word(0x4111), word(0), word(0), word(1)],
    ])
      assert.equal(candidate({ args }), false);

    assert.equal(candidate({ layout: "flags-v2" }), false);
    assert.equal(candidate({ number: word(435) }), false);
    assert.equal(candidate({ signalDepth: 1 }), false);
    assert.equal(candidate({ callEntryIsStart: false }), false);
    assert.equal(candidate({ dynamicOperationDepth: 1 }), false);
    assert.equal(candidate({ loaderCreated: true }), false);
    assert.equal(candidate({ pending: true }), false);
    assert.equal(candidate({ context: null }), false);
    assert.equal(candidate({ context: context(address, true) }), false);
    assert.equal(candidate({ context: { ...context(address), dynamic: undefined } }), false);
  });
}

test("vfork marks only the child context copy and clears the pending marker on return", () => {
  const parent = context("i64");
  const state = new DynamicVforkState();

  assert.strictEqual(state.context(parent), parent);
  const child = state.run(() => {
    assert.equal(state.pending, true);
    assert.equal(state.blocked(parent), true);
    const copy = state.context(parent);
    assert.notStrictEqual(copy, parent);
    assert.notStrictEqual(copy?.dynamic, parent.dynamic);
    assert.strictEqual(copy?.module, parent.module);
    assert.strictEqual(copy?.memory, parent.memory);
    assert.strictEqual(copy?.dynamic?.signatures, parent.dynamic?.signatures);
    assert.strictEqual(copy?.dynamic?.tagSignatures, parent.dynamic?.tagSignatures);
    assert.strictEqual(copy?.dynamic?.functionMetadata, parent.dynamic?.functionMetadata);
    assert.strictEqual(copy?.dynamic?.privateExports, parent.dynamic?.privateExports);
    assert.equal(copy?.dynamic?.vfork_child, true);
    assert.equal(parent.dynamic?.vfork_child, undefined);
    return copy;
  });

  assert.equal(state.pending, false);
  assert.equal(state.blocked(parent), false);
  assert.equal(state.blocked(child), true);
  assert.strictEqual(dynamic_vfork_context(child, false), child);

  const nextExec = context("i64");
  assert.strictEqual(state.context(nextExec), nextExec);
  assert.equal(state.blocked(nextExec), false, "a fresh exec context has no inherited marker");
});

test("vfork pending state is cleared when the kernel clone throws", () => {
  const state = new DynamicVforkState();
  const transfer = new Error("kernel control transfer");
  assert.throws(
    () =>
      state.run(() => {
        assert.equal(state.pending, true);
        throw transfer;
      }),
    (error) => error === transfer,
  );
  assert.equal(state.pending, false);
  assert.equal(state.blocked(context("i32")), false);
});
