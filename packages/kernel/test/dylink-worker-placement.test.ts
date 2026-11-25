// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  DylinkWorkerSnapshotError,
  validate_dylink_worker_snapshot,
  type DylinkWorkerSnapshot,
} from "../src/dylink_process_worker.ts";

type Range = { start: bigint; size: number };
type Space = "memory" | "table";
const modules = new Map<string, Uint8Array<ArrayBuffer>>();

function moduleBytes(memorySize: number, tableSize: number) {
  const key = `${memorySize}:${tableSize}`;
  let bytes = modules.get(key);
  if (!bytes) {
    // A real minimal module with one dylink.0 memory-info subsection. Fixture
    // sizes fit one ULEB byte, and no imports or initialization are required.
    bytes = new Uint8Array([
      0,
      0x61,
      0x73,
      0x6d,
      1,
      0,
      0,
      0,
      0,
      15,
      8,
      ...new TextEncoder().encode("dylink.0"),
      1,
      4,
      memorySize,
      0,
      tableSize,
      0,
    ]);
    new WebAssembly.Module(bytes);
    modules.set(key, bytes);
  }
  return bytes;
}

function snapshot(ranges: readonly Range[], space: Space): DylinkWorkerSnapshot {
  return {
    version: 1,
    address: "i64",
    tableAddress: "i64",
    main: {
      handle: 0n,
      lastMap: 0n,
      cursor: 16n,
      tableLength: 16,
      functionSlots: [],
      tableSlots: Array(16).fill(null),
      addressNames: [],
    },
    files: ranges.map((range, index) => ({
      key: `file-${index}`,
      path: `/file-${index}.so`,
      pin: index + 1,
      bytes: moduleBytes(space === "memory" ? range.size : 0, space === "table" ? range.size : 0),
      dependencies: [],
    })),
    groups: ranges.map((range, index) => ({
      id: index,
      root: `file-${index}`,
      handle: BigInt(index + 1),
      order: [`file-${index}`],
      lazyFunctions: [],
      functionSlots: [],
      externalSymbols: [],
      placements: [
        [
          `file-${index}`,
          {
            base: space === "memory" ? range.start : 0n,
            tableBase: space === "table" ? range.start : 0n,
          },
        ],
      ],
    })),
    objectGroups: ranges.map((_range, index) => [
      `file-${index}`,
      { groupId: index, root: `file-${index}`, handle: BigInt(index + 1) },
    ]),
    aliases: [],
    globalOrder: [],
    owners: [],
    ownerNames: [],
    nextOwner: 1,
    symbols: [],
  };
}

function overlaps(ranges: readonly Range[]) {
  for (let left = 0; left < ranges.length; left++) {
    const a = ranges[left]!;
    for (let right = left + 1; right < ranges.length; right++) {
      const b = ranges[right]!;
      if (a.start < b.start + BigInt(b.size) && b.start < a.start + BigInt(a.size)) return true;
    }
  }
  return false;
}

function check(ranges: readonly Range[], space: Space) {
  const input = snapshot(ranges, space);
  if (overlaps(ranges)) {
    assert.throws(
      () => validate_dylink_worker_snapshot(input),
      (error: unknown) =>
        error instanceof DylinkWorkerSnapshotError &&
        error.code === "EINVAL" &&
        error.message.startsWith("snapshot dynamic placements overlap:"),
    );
  } else {
    assert.doesNotThrow(() => validate_dylink_worker_snapshot(input));
  }
}

test("placement sweeps match the strict pairwise predicate for points, endpoints and intervals", () => {
  const ranges: Range[] = [];
  for (let start = 0n; start < 4n; start++)
    for (let size = 0; size < 4; size++) ranges.push({ start, size });
  for (const space of ["memory", "table"] as const)
    for (const left of ranges) for (const right of ranges) check([left, right], space);

  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const triples: Range[][] = [
    [
      { start: 0n, size: 2 },
      { start: 2n, size: 0 },
      { start: 2n, size: 3 },
    ],
    [
      { start: 0n, size: 3 },
      { start: 2n, size: 0 },
      { start: 3n, size: 0 },
    ],
    [
      { start: 2n, size: 0 },
      { start: 2n, size: 0 },
      { start: 2n, size: 0 },
    ],
    [
      { start: 0n, size: 4 },
      { start: 1n, size: 2 },
      { start: 4n, size: 0 },
    ],
  ];
  for (const space of ["memory", "table"] as const)
    for (const triple of triples)
      for (const order of orders)
        check(
          order.map((index) => triple[index]!),
          space,
        );

  for (const left of ranges)
    for (const right of ranges)
      check(
        [
          { ...left, start: left.start + (1n << 60n) },
          { ...right, start: right.start + (1n << 60n) },
        ],
        "memory",
      );
});

test("reverse owner validation preserves exact forward identities and completeness", () => {
  const input = snapshot([], "memory");
  input.owners = Array.from({ length: 2048 }, (_, index) => [`owner-${index}`, index + 1]);
  input.ownerNames = [...input.owners].reverse().map(([name, id]) => [id, name]);
  input.nextOwner = 2049;
  assert.doesNotThrow(() => validate_dylink_worker_snapshot(input));
  for (const reverse of [
    [...input.ownerNames, input.ownerNames[0]!],
    [[1, "wrong-name"], ...input.ownerNames.slice(1)],
    [[4096, "owner-0"], ...input.ownerNames.slice(1)],
  ]) {
    assert.throws(() => validate_dylink_worker_snapshot({ ...input, ownerNames: reverse }), {
      code: "EINVAL",
      message: "snapshot owner reverse mapping conflicts",
    });
  }
  assert.throws(
    () => validate_dylink_worker_snapshot({ ...input, ownerNames: input.ownerNames.slice(1) }),
    {
      code: "EINVAL",
      message: "snapshot owner maps are incomplete",
    },
  );
});
