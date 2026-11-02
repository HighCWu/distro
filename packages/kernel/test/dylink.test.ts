// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { plan_dylink_layout } from "../src/dylink.ts";
import { read_wasm_dylink, type WasmDylink } from "../src/wasm_binary.ts";

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}
const text = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
};
const section = (id: number, bytes: number[]) => [id, ...u32(bytes.length), ...bytes];
const info = section(1, [13, 4, 3, 1]);
const custom = (bytes: number[]) => section(0, [...text("dylink.0"), ...bytes]);
const module = (...sections: number[][]) =>
  new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]));
const metadata = (extra: number[] = []) => read_wasm_dylink(module(custom([...info, ...extra])))!;

test("dylink preserves dependencies, repeated symbol groups, TLS, weak imports and runpaths", () => {
  const parsed = metadata([
    ...section(2, [2, ...text("liba.so"), ...text("../lib/libb.so")]),
    ...section(3, [1, ...text("tls_counter"), ...u32(0x100)]),
    ...section(3, [1, ...text("exported"), 0]),
    ...section(4, [1, ...text("env"), ...text("optional"), 1]),
    ...section(5, [2, ...text("$ORIGIN/lib"), ...text("")]),
    ...section(6, text("wasm64")),
    ...section(99, [255, 0]),
  ]);
  assert.deepEqual(parsed, {
    memorySize: 13,
    memoryAlignment: 4,
    tableSize: 3,
    tableAlignment: 1,
    needed: ["liba.so", "../lib/libb.so"],
    exports: [
      { name: "tls_counter", flags: 0x100 },
      { name: "exported", flags: 0 },
    ],
    imports: [{ module: "env", name: "optional", flags: 1 }],
    runtimePaths: ["$ORIGIN/lib", ""],
    target: "wasm64",
    unknownSubsections: [99],
  });
  assert.equal(read_wasm_dylink(module()), null);
  assert.throws(() => read_wasm_dylink(module(custom(info), custom(info))), /duplicate/);
});

test("engine-valid custom metadata cannot bypass subsection bounds or integer/string checks", () => {
  const bad = [
    [1, 4, 0, 0, 0], // Truncated payload.
    section(1, [0xff, 0xff, 0xff, 0xff, 0x10, 0, 0, 0]), // u32 overflow.
    section(1, [0x80, 0x80, 0x80, 0x80, 0x80, 0, 0, 0]),
    section(1, [0, 0, 0, 0, 1]), // Trailing bytes.
    [...info, ...info],
    [...info, ...section(2, [...u32(0xffffffff)])],
    [...info, ...section(2, [1, 3, 97])], // String crosses subsection boundary.
    [...info, ...section(2, [1, 1, 0xff])], // Invalid UTF-8.
    [...info, ...section(2, [1, ...text("lib\0hidden")])],
    [...info, ...section(2, [1, ...text("")])],
    [...info, ...section(6, text("x86_64"))],
    [...info, ...section(6, text("wasm32")), ...section(6, text("wasm32"))],
    section(2, [0]), // No memory layout.
  ];
  for (const bytes of bad) {
    const compiled = module(custom(bytes)); // Engine accepts opaque custom bytes.
    assert.throws(() => read_wasm_dylink(compiled), { name: "WasmParseError" });
  }
});

test("every proper truncation of a complete metadata payload rejects", () => {
  // Ending at a subsection boundary is a different valid metadata document;
  // use one mandatory MEM_INFO payload so all proper truncations are invalid.
  for (let length = 0; length < info.length; length++)
    assert.throws(() => read_wasm_dylink(module(custom(info.slice(0, length)))));
});

test("layout plans use independent memory/table widths and exact memory64 offsets", () => {
  const item = metadata(section(6, text("wasm64")));
  const memory = { cursor: (1n << 54n) + 1n, limit: 1n << 55n, address: "i64" as const };
  const table = { cursor: 3n, limit: 100n, address: "i32" as const };
  const plan = plan_dylink_layout([item, item], memory, table);
  assert.deepEqual(plan, {
    items: [
      { base: (1n << 54n) + 16n, tableBase: 4n },
      { base: (1n << 54n) + 32n, tableBase: 8n },
    ],
    memoryEnd: (1n << 54n) + 45n,
    tableEnd: 11n,
  });
  assert.equal(memory.cursor, (1n << 54n) + 1n);
  assert.equal(table.cursor, 3n);
  assert.deepEqual(plan_dylink_layout([], memory, table).items, []);
});

test("late capacity failure never changes supplied arenas or metadata", () => {
  const item = metadata();
  const memory = Object.freeze({ cursor: 1n, limit: 31n, address: "i32" as const });
  const table = Object.freeze({ cursor: 1n, limit: 100n, address: "i64" as const });
  const before = structuredClone(item);
  assert.throws(() => plan_dylink_layout([item, item], memory, table), /capacity/);
  assert.deepEqual(item, before);
  assert.equal(memory.cursor, 1n);
  assert.equal(table.cursor, 1n);
});

test("address width, alignments, exclusive limits and malformed arena inputs reject", () => {
  const arena = { cursor: 0n, limit: 1n << 32n, address: "i32" as const };
  const item = metadata();
  const invalid: WasmDylink[] = [
    { ...item, target: "wasm64" },
    { ...item, memoryAlignment: 32 },
    { ...item, tableAlignment: 32 },
    { ...item, memorySize: -1 },
    { ...item, tableSize: 1.5 },
  ];
  for (const value of invalid)
    assert.throws(() => plan_dylink_layout([value], arena, arena), RangeError);
  for (const value of [
    { ...arena, cursor: -1n },
    { ...arena, cursor: 2n, limit: 1n },
    { ...arena, limit: (1n << 32n) + 1n },
  ])
    assert.throws(() => plan_dylink_layout([], value, arena), RangeError);
  assert.throws(
    () =>
      plan_dylink_layout([{ ...item, memorySize: 0 }], { ...arena, cursor: arena.limit }, arena),
    /capacity/,
  );
  const exact = plan_dylink_layout(
    [{ ...item, memoryAlignment: 0, memorySize: 1 }],
    { ...arena, cursor: arena.limit - 1n },
    arena,
  );
  assert.equal(exact.memoryEnd, 1n << 32n);
});
