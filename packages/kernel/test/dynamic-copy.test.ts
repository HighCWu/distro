// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  prepare_dylink_worker_snapshot,
  type DylinkWorkerSnapshot,
} from "../src/dylink_process_worker.ts";
import { create_dynamic_process_state, dynamic_process_value } from "../src/dynamic-thread.ts";
import {
  create_dynamic_process_copy_context,
  dynamic_process_copy_allowed,
} from "../src/dynamic-copy.ts";
import type { UserContext, WasmAddress } from "../src/wasm.ts";

const emptyModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const CLONE_VM = 0x00000100;
const CLONE_VFORK = 0x00004000;
const CLONE_THREAD = 0x00010000;

function context(address: "i32" | "i64", vforkChild = false): UserContext {
  return {
    module: emptyModule,
    memory: {} as WebAssembly.Memory,
    address,
    maximum_pages: 32,
    dynamic: {
      table: { address, minimum: 16n, maximum: 64n },
      signatures: new Map([["main", "[[],[127]]"]]),
      tagSignatures: new Map([["tag", "[[],[]]"]]),
      functionMetadata: new Map([["main", { signature: "[[],[127]]", imported: false }]]),
      privateExports: new Set(["private"]),
      process_state: create_dynamic_process_state(),
      ...(vforkChild ? { vfork_child: true } : {}),
    },
  };
}

function word(address: "i32" | "i64", value: number): WasmAddress {
  return address === "i64" ? BigInt(value) : value;
}

function emptySnapshot(address: "i32" | "i64"): DylinkWorkerSnapshot {
  return prepare_dylink_worker_snapshot({
    version: 1,
    address,
    tableAddress: address,
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
}

for (const address of ["i32", "i64"] as const) {
  const candidate = (overrides: Partial<Parameters<typeof dynamic_process_copy_allowed>[0]> = {}) =>
    dynamic_process_copy_allowed({
      context: context(address),
      layout: "callback-v1",
      number: word(address, 220),
      args: [
        word(address, 1),
        word(address, 0),
        word(address, 0),
        0 as WasmAddress,
        0 as WasmAddress,
        0 as WasmAddress,
      ],
      signalDepth: 0,
      callEntryIsNormal: true,
      dynamicOperationDepth: 0,
      vforkPending: false,
      ...overrides,
    });

  test(`${address}: admits only the private-memory callback process-copy shape`, () => {
    assert.equal(candidate(), true);
    const highFlag = address === "i64" ? 1n << 63n : 0x80000000;
    assert.equal(
      candidate({
        args: [
          word(address, 1),
          word(address, 0),
          highFlag,
          word(address, 0),
          word(address, 0),
          word(address, 0),
        ],
      }),
      true,
      "unrecognized flag bits remain for Linux to validate at the full guest width",
    );
    assert.equal(
      candidate({
        args: [
          word(address, 1),
          word(address, 0),
          word(address, 0x800000),
          word(address, 7),
          word(address, 8),
          word(address, 9),
        ],
      }),
      true,
      "other clone flags and pointer arguments are left for Linux",
    );
    assert.equal(
      candidate({
        args: [
          word(address, 1),
          word(address, 0),
          word(address, 0),
          word(address, 0),
          word(address, 0),
          word(address, 0),
        ],
      }),
      true,
      "the callback argument is opaque and need not be non-null",
    );

    for (const flag of [CLONE_VM, CLONE_THREAD, CLONE_VFORK]) {
      assert.equal(
        candidate({
          args: [
            word(address, 1),
            word(address, 0),
            word(address, flag),
            word(address, 0),
            word(address, 0),
            word(address, 0),
          ],
        }),
        false,
        `copy admission excludes clone flag 0x${flag.toString(16)}`,
      );
    }
    assert.equal(
      candidate({
        args: [
          word(address, 0),
          word(address, 0),
          word(address, 0),
          word(address, 0),
          word(address, 0),
          word(address, 0),
        ],
      }),
      false,
    );
    assert.equal(candidate({ args: [word(address, 1)] }), false);
    assert.equal(candidate({ layout: "flags-v2" }), false);
    assert.equal(candidate({ number: word(address, 435) }), false);
    assert.equal(candidate({ signalDepth: 1 }), false);
    assert.equal(candidate({ callEntryIsNormal: false }), false);
    assert.equal(candidate({ dynamicOperationDepth: 1 }), false);
    assert.equal(candidate({ vforkPending: true }), false);
    assert.equal(candidate({ context: null }), false);
    assert.equal(candidate({ context: context(address, true) }), false);
    assert.equal(candidate({ context: { ...context(address), dynamic: undefined } }), false);
  });
}

test("process-copy context owns fresh loader state and detached dynamic metadata", () => {
  for (const address of ["i32", "i64"] as const) {
    const parent = context(address);
    const snapshot = structuredClone(emptySnapshot(address));
    const staleMembership = { shared: {}, participant: {} } as NonNullable<
      NonNullable<UserContext["dynamic"]>["worker_membership"]
    >;
    parent.dynamic!.worker_membership = staleMembership;
    parent.dynamic!.worker_publication = { processIdentity: "parent", generation: 4 };
    parent.dynamic!.vfork_child = true;

    const child = create_dynamic_process_copy_context(parent, snapshot);

    assert.notStrictEqual(child, parent);
    assert.strictEqual(child.module, parent.module);
    assert.strictEqual(
      child.memory,
      parent.memory,
      "the kernel COPY path supplies private memory later",
    );
    assert.equal(child.address, parent.address);
    assert.equal(child.maximum_pages, parent.maximum_pages);
    assert.notStrictEqual(child.dynamic, parent.dynamic);
    assert.notStrictEqual(child.dynamic!.table, parent.dynamic!.table);
    assert.notStrictEqual(child.dynamic!.signatures, parent.dynamic!.signatures);
    assert.notStrictEqual(child.dynamic!.tagSignatures, parent.dynamic!.tagSignatures);
    assert.notStrictEqual(child.dynamic!.functionMetadata, parent.dynamic!.functionMetadata);
    assert.notStrictEqual(
      child.dynamic!.functionMetadata.get("main"),
      parent.dynamic!.functionMetadata.get("main"),
    );
    child.dynamic!.functionMetadata.get("main")!.signature = "child-only";
    assert.equal(parent.dynamic!.functionMetadata.get("main")!.signature, "[[],[127]]");
    assert.notStrictEqual(child.dynamic!.privateExports, parent.dynamic!.privateExports);
    assert.equal(child.dynamic!.worker_membership, undefined);
    assert.equal(child.dynamic!.worker_publication, undefined);
    assert.equal(child.dynamic!.vfork_child, undefined);

    assert.notStrictEqual(child.dynamic!.process_state, parent.dynamic!.process_state);
    assert.equal(dynamic_process_value(child.dynamic!.process_state), -1);
    assert.equal(dynamic_process_value(parent.dynamic!.process_state), 0);
    assert.notStrictEqual(child.dynamic!.worker_snapshot, snapshot);
    assert.equal(child.dynamic!.worker_snapshot!.main.cursor, 0n);
    snapshot.main.cursor = 1n; // Structured-clone input is not retained by reference.
    snapshot.main.handle = 9n;
    assert.equal(child.dynamic!.worker_snapshot!.main.handle, 0n);
  }
});

test("process-copy context rejects snapshot ABI mismatches", () => {
  assert.throws(
    () => create_dynamic_process_copy_context(context("i64"), emptySnapshot("i32")),
    /snapshot ABI does not match/,
  );
});

test("process copy without a replay snapshot keeps a fresh loader state pristine", () => {
  const parent = context("i64");
  parent.dynamic!.worker_snapshot = emptySnapshot("i64");
  parent.dynamic!.worker_publication = { processIdentity: "parent", generation: 4 };
  parent.dynamic!.worker_membership = { shared: {}, participant: {} } as NonNullable<
    NonNullable<UserContext["dynamic"]>["worker_membership"]
  >;

  const child = create_dynamic_process_copy_context(parent);

  assert.notStrictEqual(child.dynamic!.process_state, parent.dynamic!.process_state);
  assert.equal(dynamic_process_value(child.dynamic!.process_state), 0);
  assert.equal(child.dynamic!.worker_snapshot, undefined);
  assert.equal(child.dynamic!.worker_publication, undefined);
  assert.equal(child.dynamic!.worker_membership, undefined);
  assert.equal(child.dynamic!.vfork_child, undefined);
  assert.ok(parent.dynamic!.worker_snapshot, "the parent remains unchanged");
});
