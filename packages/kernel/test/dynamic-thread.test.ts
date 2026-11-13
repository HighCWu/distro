// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  claim_dynamic_loader,
  create_dynamic_process_state,
  DYNAMIC_THREAD_COUNT_MASK,
  dynamic_process_is_pristine,
  dynamic_process_is_threaded,
  dynamic_process_value,
  dynamic_thread_clone_allowed,
  run_dynamic_thread_clone,
  release_dynamic_loader_claim,
  restore_dynamic_table,
  snapshot_dynamic_table,
} from "../src/dynamic-thread.ts";
import type { UserContext, WasmAddress } from "../src/wasm.ts";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const tableFixture = new WebAssembly.Instance(
  new WebAssembly.Module(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 0x60, 0, 1, 0x7f, 3, 3, 2, 0, 0, 7, 9, 2, 1, 0x66, 0, 0,
      1, 0x67, 0, 1, 10, 11, 2, 4, 0, 0x41, 1, 0x0b, 4, 0, 0x41, 2, 0x0b,
    ]),
  ),
).exports as { f: CallableFunction; g: CallableFunction };
const CLONE_VM = 0x100;
const CLONE_THREAD = 0x10000;

function context(address: "i32" | "i64", vforkChild = false): UserContext {
  return {
    module,
    memory: {} as WebAssembly.Memory,
    address,
    maximum_pages: 8,
    dynamic: {
      table: { address, minimum: 4n },
      signatures: new Map(),
      tagSignatures: new Map(),
      functionMetadata: new Map(),
      privateExports: new Set(),
      process_state: create_dynamic_process_state(),
      ...(vforkChild ? { vfork_child: true } : {}),
    },
  };
}

for (const address of ["i32", "i64"] as const) {
  const word = (value: number): WasmAddress => (address === "i64" ? BigInt(value) : value);
  const candidate = (
    overrides: Partial<Parameters<typeof dynamic_thread_clone_allowed>[0]> = {},
  ) => {
    const parent = context(address);
    const highFlag = address === "i64" ? 1n << 40n : 0n;
    const flags =
      address === "i64" ? BigInt(CLONE_VM | CLONE_THREAD) | highFlag : CLONE_VM | CLONE_THREAD;
    return dynamic_thread_clone_allowed({
      context: parent,
      layout: "callback-v1",
      number: word(220),
      args: [word(1), word(0x1234), flags, word(0), word(0), word(0)],
      signalDepth: 0,
      callEntryIsNormal: true,
      dynamicOperationDepth: 0,
      vforkPending: false,
      sharedMemory: true,
      ...overrides,
    });
  };

  test(`${address}: admits callback-v1 shared VM thread clones and preserves full flag width`, () => {
    assert.equal(candidate(), true);
    assert.equal(
      candidate({
        args: [word(1), word(0), word(CLONE_VM | CLONE_THREAD), word(0), word(0), word(0)],
      }),
      true,
      "a null callback argument remains opaque and valid for admission",
    );
    assert.equal(
      candidate({
        args: [word(1), word(0x1234), word(CLONE_VM | CLONE_THREAD), word(9), word(8), word(7)],
      }),
      true,
      "the kernel validates the remaining pointer arguments",
    );
    if (address === "i64") {
      assert.equal(
        candidate({
          args: [
            word(1),
            word(0),
            BigInt(CLONE_VM | CLONE_THREAD) | (1n << 63n),
            word(0),
            word(0),
            word(0),
          ],
        }),
        true,
        "high flag bits reach the kernel for validation without truncation",
      );
    }

    const base = [word(1), word(0), word(CLONE_VM | CLONE_THREAD), word(0), word(0), word(0)];
    for (const args of [
      [word(0), ...base.slice(1)],
      [word(1), word(0), word(CLONE_VM), word(0), word(0), word(0)],
      [word(1), word(0), word(CLONE_THREAD), word(0), word(0), word(0)],
      [word(1), word(0), word(CLONE_VM | CLONE_THREAD), word(0), word(0)],
    ])
      assert.equal(candidate({ args }), false);

    assert.equal(candidate({ layout: "flags-v2" }), false);
    assert.equal(candidate({ number: word(435) }), false);
    assert.equal(candidate({ signalDepth: 1 }), false);
    assert.equal(candidate({ callEntryIsNormal: false }), false);
    assert.equal(candidate({ dynamicOperationDepth: 1 }), false);
    assert.equal(candidate({ vforkPending: true }), false);
    assert.equal(candidate({ sharedMemory: false }), false);
    assert.equal(candidate({ context: context(address, true) }), false);
    assert.equal(candidate({ context: null }), false);
  });
}

test("concurrent clone failures release only their own claims", () => {
  const state = create_dynamic_process_state();
  assert.equal(dynamic_process_is_pristine(state), true);

  const result = run_dynamic_thread_clone(state, "i64", () => {
    assert.equal(dynamic_process_value(state), 1);
    const second = run_dynamic_thread_clone(state, "i64", () => -11n);
    assert.equal(second, -11n);
    assert.equal(dynamic_process_value(state), 1);
    return -12n;
  });
  assert.equal(result, -12n);
  assert.equal(dynamic_process_value(state), 0);
  assert.equal(dynamic_process_is_pristine(state), true);
});

test("a successful concurrent clone survives another clone's negative errno", () => {
  const state = create_dynamic_process_state();
  const result = run_dynamic_thread_clone(state, "i32", () => {
    const second = run_dynamic_thread_clone(state, "i32", () => 123);
    assert.equal(second, 123);
    assert.equal(dynamic_process_value(state), 0x40000001);
    return -11;
  });

  assert.equal(result, -11);
  assert.equal(dynamic_process_value(state), 0x40000000);
  assert.equal(dynamic_process_is_threaded(state), true);
  assert.equal(claim_dynamic_loader(state), false);
});

test("loader and first thread claims are mutually exclusive in either order", () => {
  const loaderFirst = create_dynamic_process_state();
  assert.equal(claim_dynamic_loader(loaderFirst), true);
  assert.equal(claim_dynamic_loader(loaderFirst), false);
  assert.equal(
    run_dynamic_thread_clone(loaderFirst, "i32", () => 1),
    -95,
  );
  assert.equal(dynamic_process_value(loaderFirst), -1);

  const threadFirst = create_dynamic_process_state();
  assert.equal(
    run_dynamic_thread_clone(threadFirst, "i32", () => 1),
    1,
  );
  assert.equal(claim_dynamic_loader(threadFirst), false);
  assert.equal(dynamic_process_is_threaded(threadFirst), true);
});

test("a rejected pristine replay bootstrap releases only its loader claim to the legacy clone path", () => {
  const state = create_dynamic_process_state();
  assert.equal(dynamic_process_is_pristine(state), true);

  assert.equal(
    claim_dynamic_loader(state),
    true,
    "first clone temporarily claims loader ownership",
  );
  assert.equal(dynamic_process_value(state), -1);
  assert.equal(
    release_dynamic_loader_claim(state),
    true,
    "unsupported replay releases its own claim",
  );
  assert.equal(dynamic_process_value(state), 0);

  assert.equal(
    run_dynamic_thread_clone(state, "i32", () => 0),
    0,
  );
  assert.equal(dynamic_process_is_threaded(state), true);
  assert.equal(
    release_dynamic_loader_claim(state),
    false,
    "a published thread state is never reset",
  );
});

test("a failed legacy clone after replay fallback leaves the loader retryable", () => {
  const state = create_dynamic_process_state();
  assert.equal(claim_dynamic_loader(state), true);
  assert.equal(release_dynamic_loader_claim(state), true);

  assert.equal(
    run_dynamic_thread_clone(state, "i64", () => -11n),
    -11n,
  );
  assert.equal(dynamic_process_value(state), 0);
  assert.equal(claim_dynamic_loader(state), true, "a later dlopen can reclaim the idle loader");
});

test("loader rollback snapshots and restores table32 and table64 indices at their ABI width", () => {
  for (const address of ["i32", "i64"] as const) {
    const table = new WebAssembly.Table({
      element: "anyfunc",
      initial: address === "i64" ? 2n : 2,
      address,
    } as unknown as WebAssembly.TableDescriptor);
    const first = tableFixture.f;
    const replacement = tableFixture.g;
    const added = tableFixture.g;
    const index = (value: number) => (address === "i64" ? BigInt(value) : value);
    const set = table.set as unknown as (
      slot: number | bigint,
      fn: CallableFunction | null,
    ) => void;
    const get = table.get as unknown as (slot: number | bigint) => CallableFunction | null;

    set.call(table, index(0), first);
    const snapshot = snapshot_dynamic_table(table, address);
    set.call(table, index(0), replacement);
    const grow = table.grow as unknown as (delta: number | bigint) => number | bigint;
    grow.call(table, address === "i64" ? 1n : 1);
    set.call(table, index(2), added);

    restore_dynamic_table(table, address, snapshot);
    assert.equal(get.call(table, index(0)), first);
    assert.equal(get.call(table, index(1)), null);
    assert.equal(get.call(table, index(2)), null);
  }
});

test("missing process state fails with the existing unsupported-operation errno", () => {
  assert.equal(
    run_dynamic_thread_clone(undefined, "i64", () => 1n),
    -95n,
  );
});

test("an unknown throw conservatively keeps the process threaded", () => {
  const state = create_dynamic_process_state();
  const failure = new Error("unknown kernel control transfer");
  assert.throws(
    () =>
      run_dynamic_thread_clone(state, "i64", () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.equal(dynamic_process_value(state), 0x40000000);
  assert.equal(dynamic_process_is_threaded(state), true);
});

test("the in-flight claim counter fails closed at its representable limit", () => {
  const state = create_dynamic_process_state();
  Atomics.store(new Int32Array(state), 0, DYNAMIC_THREAD_COUNT_MASK);
  assert.equal(
    run_dynamic_thread_clone(state, "i32", () => assert.fail("must not invoke")),
    -11,
  );
  assert.equal(dynamic_process_value(state), DYNAMIC_THREAD_COUNT_MASK);
});
