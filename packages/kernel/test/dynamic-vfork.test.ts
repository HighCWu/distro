// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  DynamicVforkState,
  dynamic_vfork_allowed,
  dynamic_vfork_context,
  dynamic_vfork_replay_allowed,
} from "../src/dynamic-vfork.ts";
import { create_dynamic_process_state, DYNAMIC_LOADER_CLAIMED } from "../src/dynamic-thread.ts";
import { prepare_dylink_worker_snapshot } from "../src/dylink_process_worker.ts";
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
      process_state: create_dynamic_process_state(),
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

  test(`${address}: settled loaded vfork requires the single-threaded loader claim without a cohort`, () => {
    const loaded = context(address);
    Atomics.store(new Int32Array(loaded.dynamic!.process_state!), 0, DYNAMIC_LOADER_CLAIMED);
    assert.equal(candidate({ context: loaded, loaderCreated: true }), true);
    assert.equal(candidate({ context: loaded, loaderCreated: false }), false);
    for (const value of [0, 1, 0x20000000, 0x40000000]) {
      Atomics.store(new Int32Array(loaded.dynamic!.process_state!), 0, value);
      assert.equal(candidate({ context: loaded, loaderCreated: true }), false);
    }
    Atomics.store(new Int32Array(loaded.dynamic!.process_state!), 0, DYNAMIC_LOADER_CLAIMED);
    loaded.dynamic!.worker_publication = { processIdentity: "cohort", generation: 0 };
    assert.equal(candidate({ context: loaded, loaderCreated: true }), false);
    delete loaded.dynamic!.worker_publication;
    loaded.dynamic!.worker_membership = {} as NonNullable<
      typeof loaded.dynamic
    >["worker_membership"];
    assert.equal(candidate({ context: loaded, loaderCreated: true }), false);
    delete loaded.dynamic!.worker_membership;
    delete loaded.dynamic!.process_state;
    assert.equal(candidate({ context: loaded, loaderCreated: true }), false);
  });
}

test("vfork replay snapshot is child-only, requires no cohort and clears on failure or retry", () => {
  const parent = context("i64");
  Atomics.store(new Int32Array(parent.dynamic!.process_state!), 0, DYNAMIC_LOADER_CLAIMED);
  const snapshot = prepare_dylink_worker_snapshot({
    version: 1,
    address: "i64",
    tableAddress: "i64",
    main: {
      handle: 0n,
      lastMap: 0n,
      cursor: 0n,
      tableLength: 0,
      functionSlots: [],
      tableSlots: [],
      addressNames: [],
    },
    files: [],
    groups: [],
    objectGroups: [],
    aliases: [],
    globalOrder: [],
    owners: [],
    ownerNames: [],
    nextOwner: 1,
    symbols: [],
  });
  const state = new DynamicVforkState();
  const child = state.run(() => {
    const child = state.context(parent)!;
    assert.equal(child.dynamic?.vfork_child, true);
    assert.equal(child.memory, parent.memory);
    assert.equal(child.dynamic?.worker_snapshot, snapshot);
    assert.equal(child.dynamic?.worker_membership, undefined);
    assert.equal(child.dynamic?.worker_publication, undefined);
    assert.equal(dynamic_vfork_replay_allowed(child), true);
    assert.equal(parent.dynamic?.worker_snapshot, undefined);
    assert.equal(parent.dynamic?.vfork_child, undefined);
    return child;
  }, snapshot);
  assert.equal(state.context(parent), parent);
  assert.equal(dynamic_vfork_replay_allowed(parent), false);
  assert.equal(
    dynamic_vfork_replay_allowed({
      ...child,
      dynamic: { ...child.dynamic!, worker_snapshot: undefined },
    }),
    false,
  );
  assert.equal(
    dynamic_vfork_replay_allowed({
      ...child,
      dynamic: {
        ...child.dynamic!,
        worker_publication: { processIdentity: "cohort", generation: 0 },
      },
    }),
    false,
  );
  assert.equal(
    dynamic_vfork_replay_allowed({
      ...child,
      dynamic: {
        ...child.dynamic!,
        worker_membership: {} as NonNullable<typeof child.dynamic>["worker_membership"],
      },
    }),
    false,
  );
  const failure = new Error("clone failed");
  assert.throws(
    () =>
      state.run(() => {
        throw failure;
      }, snapshot),
    (error) => error === failure,
  );
  assert.equal(state.pending, false);
  state.run(() => assert.equal(state.context(parent)?.dynamic?.worker_snapshot, undefined));
  assert.equal(parent.dynamic?.worker_snapshot, undefined);
});

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
