// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { prepare_dylink_call_metadata } from "../src/dylink_call_metadata.ts";
import { read_wasm_dynamic_signatures } from "../src/wasm_binary.ts";

const header = [0, 97, 115, 109, 1, 0, 0, 0];
const text = (name: string) => {
  const bytes = [...new TextEncoder().encode(name)];
  return [bytes.length, ...bytes];
};
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
const binary = (...sections: number[][]) => new Uint8Array([...header, ...sections.flat()]);
function fixture(width: 32 | 64, reexport = false) {
  const word = width === 64 ? 0x7e : 0x7f,
    constant = width === 64 ? 0x42 : 0x41;
  return binary(
    section(1, [2, 0x60, 1, word, 1, word, 0x60, 0, 1, word]),
    section(2, [1, ...text("env"), ...text("increment"), 0, 0]),
    section(3, [3, 1, 1, 1]),
    section(4, [1, 0x70, 0, 1]),
    section(5, [1, width === 64 ? 4 : 0, 1]),
    section(7, [
      4,
      ...text("pointer"),
      0,
      2,
      ...text("invoke"),
      0,
      reexport ? 0 : 3,
      ...text("__wasm_private_call_0"),
      0,
      2,
      ...text("table"),
      1,
      0,
    ]),
    section(9, [1, 0, 0x41, 0, 0x0b, 1, 1]),
    section(10, [
      3,
      6,
      0,
      constant,
      41,
      0x10,
      0,
      0x0b,
      4,
      0,
      constant,
      0,
      0x0b,
      4,
      0,
      0x10,
      1,
      0x0b,
    ]),
  );
}

function sections(bytes: Uint8Array) {
  let offset = 8;
  const u32 = () => {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      shift += 7;
    } while (byte & 128);
    return value;
  };
  const result: { id: number; raw: Uint8Array }[] = [];
  while (offset < bytes.length) {
    const start = offset,
      id = bytes[offset++]!,
      length = u32();
    offset += length;
    result.push({ id, raw: bytes.slice(start, offset) });
  }
  return result;
}

for (const width of [32, 64] as const)
  test(`private function metadata retains wasm${width} imports, hidden pointers and public names`, () => {
    const original = fixture(width),
      saved = original.slice();
    const word = width === 64 ? 0x7e : 0x7f;
    const signatures = read_wasm_dynamic_signatures(original, true);
    assert.deepEqual(signatures.functions, [
      JSON.stringify([[word], [word]]),
      ...Array(3).fill(JSON.stringify([[], [word]])),
    ]);
    assert.throws(() => prepare_dylink_call_metadata(original), /private table/);
    const prepared = prepare_dylink_call_metadata(original, true);
    assert.deepEqual(original, saved);
    assert.notEqual(prepared.bytes.buffer, original.buffer);
    assert.equal(prepared.privateExports.has("__wasm_private_call_0"), false);
    assert.equal(prepared.functions.size, 4);
    assert.deepEqual(
      [...prepared.functions.values()],
      signatures.functions.map((signature, index) => ({ signature, imported: index === 0 })),
    );
    const module = new WebAssembly.Module(prepared.bytes);
    const instance = new WebAssembly.Instance(module, {
      env: {
        increment: (value: number | bigint) => (typeof value === "bigint" ? value + 1n : value + 1),
      },
    });
    const exports = instance.exports;
    const result = width === 64 ? 42n : 42,
      zero = width === 64 ? 0n : 0;
    assert.equal((exports.invoke as CallableFunction)(), result);
    assert.equal((exports.pointer as CallableFunction)(), zero);
    assert.equal((exports.__wasm_private_call_0 as CallableFunction)(), zero);
    const privateNames = [...prepared.functions.keys()];
    assert.equal((exports[privateNames[0]!] as CallableFunction)(width === 64 ? 41n : 41), result);
    assert.equal(exports[privateNames[1]!], (exports.table as WebAssembly.Table).get(0));
    assert.equal((exports[privateNames[1]!] as CallableFunction)(), result);
    assert.deepEqual(
      sections(prepared.bytes).filter((part) => part.id !== 7),
      sections(original).filter((part) => part.id !== 7),
    );
    assert.throws(() => prepare_dylink_call_metadata(fixture(width, true), true), /re-exports/);
  });

test("missing export sections are inserted after tags/globals and before start/code", () => {
  for (const start of [false, true]) {
    const original = binary(
      section(0, text("before")),
      section(1, [1, 0x60, 0, 0]),
      section(3, [1, 0]),
      section(13, [1, 0, 0]),
      section(6, [1, 0x7f, 0, 0x41, 7, 0x0b]),
      section(0, text("between")),
      ...(start ? [section(8, [0])] : []),
      section(10, [1, 2, 0, 0x0b]),
    );
    assert.doesNotThrow(() => new WebAssembly.Module(original));
    const prepared = prepare_dylink_call_metadata(original);
    const ids = sections(prepared.bytes).map((part) => part.id);
    assert.deepEqual(ids, [0, 1, 3, 13, 6, 0, 7, ...(start ? [8] : []), 10]);
    const instance = new WebAssembly.Instance(new WebAssembly.Module(prepared.bytes));
    assert.equal(
      (instance.exports[[...prepared.functions.keys()][0]!] as CallableFunction)(),
      undefined,
    );
    assert.deepEqual(
      sections(prepared.bytes).filter((part) => part.id !== 7),
      sections(original),
    );
  }
});

test("unexported SIMD functions retain their actual numeric signature", () => {
  const original = binary(
    section(1, [1, 0x60, 1, 0x7b, 1, 0x7b]),
    section(3, [1, 0]),
    section(10, [1, 4, 0, 0x20, 0, 0x0b]),
  );
  const prepared = prepare_dylink_call_metadata(original);
  const [name, metadata] = [...prepared.functions][0]!;
  assert.equal(metadata.signature, JSON.stringify([[0x7b], [0x7b]]));
  assert.equal(metadata.imported, false);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(prepared.bytes));
  assert.equal(typeof instance.exports[name], "function");
});

test("metadata rejects malformed section/name bounds and duplicate sections", () => {
  const valid = fixture(32);
  assert.throws(() => prepare_dylink_call_metadata(valid.slice(0, -1), true), /extends past/);
  assert.throws(
    () => prepare_dylink_call_metadata(new Uint8Array([...header, 7, 255, 255, 255, 255, 16])),
    /LEB128 overflows/,
  );
  const types = section(1, [1, 0x60, 0, 0]);
  assert.throws(
    () => prepare_dylink_call_metadata(binary(types, types)),
    /duplicate section order/,
  );
  assert.throws(() => prepare_dylink_call_metadata(binary(section(7, [1, 10]))), /extends past/);
  assert.throws(() => prepare_dylink_call_metadata(binary(section(7, [1, 1, 255, 0, 0]))), /UTF-8/);
  assert.throws(
    () => prepare_dylink_call_metadata(binary(section(3, [1, 1]))),
    /invalid dynamic function type/,
  );
});
