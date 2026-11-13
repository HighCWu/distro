// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  apply_dylink_worker_publication,
  DylinkWorkerSnapshotError,
  prepare_dylink_worker_snapshot,
} from "../src/dylink_process_worker.ts";
import { create_dylink_worker_publication_delta } from "../src/dylink_worker_publication.ts";

const u32 = (value: number) => {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
};
const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
};
const section = (id: number, payload: number[]) => [id, ...u32(payload.length), ...payload];
const custom = (name: string, payload: number[]) => section(0, [...text(name), ...payload]);

/** A real, compilable dylink module with imported process memory/table and exported functions. */
function dynamicModule(exports: readonly (readonly [string, number])[]) {
  const dylink = [
    ...section(1, [...u32(0), ...u32(0), ...u32(0), ...u32(0)]),
    ...section(2, [0]),
    ...section(3, [
      ...u32(exports.length),
      ...exports.flatMap(([name]) => [...text(name), ...u32(0)]),
    ]),
    ...section(4, [0]),
  ];
  const imports = [
    4,
    ...text("env"),
    ...text("memory"),
    2,
    3,
    ...u32(1),
    ...u32(4),
    ...text("env"),
    ...text("__indirect_function_table"),
    1,
    0x70,
    1,
    ...u32(4),
    ...u32(4096),
    ...text("env"),
    ...text("__memory_base"),
    3,
    0x7f,
    0,
    ...text("env"),
    ...text("__table_base"),
    3,
    0x7f,
    0,
  ];
  const functionBodies = exports.flatMap(([, result]) => {
    const body = [0, 0x41, result, 0x0b];
    return [...u32(body.length), ...body];
  });
  const bytes = new Uint8Array([
    0,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0,
    ...custom("dylink.0", dylink),
    ...section(1, [1, 0x60, 0, 1, 0x7f]),
    ...section(2, imports),
    ...section(3, [...u32(exports.length), ...exports.flatMap(() => [0])]),
    ...section(7, [
      ...u32(exports.length),
      ...exports.flatMap(([name], index) => [...text(name), 0, ...u32(index)]),
    ]),
    ...section(10, [...u32(exports.length), ...functionBodies]),
  ]);
  assert.doesNotThrow(() => new WebAssembly.Module(bytes));
  return bytes;
}

const rootBytes = dynamicModule([
  ["entry", 7],
  ["secondary", 8],
]);
const lateBytes = dynamicModule([["answer", 9]]);

function baseSnapshot(rootModule = rootBytes) {
  return prepare_dylink_worker_snapshot({
    version: 1,
    address: "i32",
    tableAddress: "i32",
    main: {
      handle: 7n,
      lastMap: 128n,
      cursor: 4n,
      tableLength: 4,
      functionSlots: [["main_entry", 0n]],
      tableSlots: [
        { moduleKey: "main", exportAlias: "main_entry" },
        null,
        null,
        { moduleKey: "root", exportAlias: "entry" },
      ],
      addressNames: [["root_address", 256n]],
    },
    files: [
      {
        key: "root",
        path: "/plugins/root.so",
        bytes: rootModule,
        pin: 1,
        handle: 20n,
        dependencies: [],
      },
    ],
    groups: [
      {
        id: 0,
        root: "root",
        handle: 20n,
        order: ["root"],
        lazyFunctions: [],
        placements: [["root", { base: 512n, tableBase: 3n }]],
        functionSlots: [["root", [["entry", 3n]]]],
        externalSymbols: [],
      },
    ],
    objectGroups: [["root", { groupId: 0, root: "root", handle: 20n }]],
    aliases: [["root-alias", "root"]],
    globalOrder: ["root"],
    owners: [["root-owner", 1]],
    ownerNames: [[1, "root-owner"]],
    nextOwner: 2,
    symbols: [
      [
        "root_entry",
        {
          moduleKey: "root",
          exportAlias: "entry",
          kind: "function",
          signature: "[[],[127]]",
          address: 512n,
        },
      ],
    ],
  });
}

function nextSnapshot(rootModule = rootBytes) {
  return prepare_dylink_worker_snapshot({
    version: 1,
    address: "i32",
    tableAddress: "i32",
    main: {
      handle: 7n,
      lastMap: 768n,
      cursor: 7n,
      tableLength: 7,
      functionSlots: [
        ["main_entry", 0n],
        ["main_added", 6n],
      ],
      tableSlots: [
        { moduleKey: "main", exportAlias: "main_entry" },
        null,
        null,
        { moduleKey: "root", exportAlias: "entry" },
        { moduleKey: "root", exportAlias: "secondary" },
        { moduleKey: "late", exportAlias: "answer" },
        { moduleKey: "main", exportAlias: "main_added" },
      ],
      addressNames: [
        ["root_address", 256n],
        ["late_address", 640n],
      ],
    },
    files: [
      {
        key: "root",
        path: "/plugins/root.so",
        bytes: rootModule,
        pin: 1,
        handle: 20n,
        dependencies: [],
      },
      {
        key: "late",
        path: "/plugins/late.so",
        bytes: lateBytes,
        pin: 2,
        handle: 30n,
        dependencies: [],
      },
    ],
    groups: [
      {
        id: 0,
        root: "root",
        handle: 20n,
        order: ["root"],
        lazyFunctions: [],
        placements: [["root", { base: 512n, tableBase: 3n }]],
        functionSlots: [
          [
            "root",
            [
              ["entry", 3n],
              ["secondary", 4n],
            ],
          ],
        ],
        externalSymbols: [],
      },
      {
        id: 1,
        root: "late",
        handle: 30n,
        order: ["late"],
        lazyFunctions: [],
        placements: [["late", { base: 640n, tableBase: 5n }]],
        functionSlots: [["late", [["answer", 5n]]]],
        externalSymbols: [],
      },
    ],
    objectGroups: [
      ["root", { groupId: 0, root: "root", handle: 20n }],
      ["late", { groupId: 1, root: "late", handle: 30n }],
    ],
    aliases: [
      ["root-alias", "root"],
      ["late-alias", "late"],
    ],
    globalOrder: ["root", "late"],
    owners: [
      ["root-owner", 1],
      ["late-owner", 2],
    ],
    ownerNames: [
      [1, "root-owner"],
      [2, "late-owner"],
    ],
    nextOwner: 3,
    symbols: [
      [
        "root_entry",
        {
          moduleKey: "root",
          exportAlias: "entry",
          kind: "function",
          signature: "[[],[127]]",
          address: 512n,
        },
      ],
      [
        "late_answer",
        {
          moduleKey: "late",
          exportAlias: "answer",
          kind: "function",
          signature: "[[],[127]]",
          address: 640n,
        },
      ],
    ],
  });
}

test("Worker publication delta preserves existing state and reconstructs a real appended Wasm group", () => {
  const base = baseSnapshot();
  const next = nextSnapshot();
  const delta = create_dylink_worker_publication_delta(base, next, "process-delta", 4);

  assert.equal(delta.baseGeneration, 4);
  assert.equal(delta.generation, 5);
  assert.equal(delta.files.length, 1);
  assert.equal(delta.groups.length, 1);
  assert.deepEqual(delta.groupFunctionSlots, [[0, [["root", [["secondary", 4n]]]]]]);
  assert.deepEqual(delta.main.functionSlots, [["main_added", 6n]]);
  assert.deepEqual(delta.main.tableSlots, [
    [4, { moduleKey: "root", exportAlias: "secondary" }],
    [5, { moduleKey: "late", exportAlias: "answer" }],
    [6, { moduleKey: "main", exportAlias: "main_added" }],
  ]);
  assert.deepEqual(delta.main.addressNames, [["late_address", 640n]]);
  assert.notEqual(delta.files[0]!.bytes.buffer, next.files[1]!.bytes.buffer);

  const applied = apply_dylink_worker_publication(base, "process-delta", 4, structuredClone(delta));
  assert.equal(applied.generation, 5);
  assert.deepEqual(
    applied.snapshot,
    next,
    "BigInt fields and Wasm byte arrays are compared semantically",
  );
});

test("Worker publication delta rejects mutations of existing records and table slots", () => {
  const base = baseSnapshot();
  const changedFile = nextSnapshot();
  const changedFileInput = {
    ...changedFile,
    files: changedFile.files.map((file, index) =>
      index === 0 ? { ...file, path: "/plugins/renamed.so" } : file,
    ),
  };
  const preparedChangedFile = prepare_dylink_worker_snapshot(changedFileInput);
  assert.throws(
    () => create_dylink_worker_publication_delta(base, preparedChangedFile, "process-delta", 0),
    (error) => error instanceof DylinkWorkerSnapshotError && error.code === "EINVAL",
  );

  const changedBytes = nextSnapshot(
    dynamicModule([
      ["entry", 7],
      ["secondary", 10],
    ]),
  );
  assert.throws(
    () => create_dylink_worker_publication_delta(base, changedBytes, "process-delta", 0),
    (error) => error instanceof DylinkWorkerSnapshotError && error.code === "EINVAL",
    "existing module bytes are compared byte-for-byte",
  );

  const changedTableInput = {
    ...base,
    main: {
      ...base.main,
      tableSlots: [
        base.main.tableSlots[0],
        base.main.tableSlots[1],
        base.main.tableSlots[2],
        { moduleKey: "root", exportAlias: "secondary" },
      ],
    },
  };
  const changedTable = prepare_dylink_worker_snapshot(changedTableInput);
  assert.throws(
    () => create_dylink_worker_publication_delta(base, changedTable, "process-delta", 0),
    (error) => error instanceof DylinkWorkerSnapshotError && error.code === "EINVAL",
  );
});
