// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { write_exec_image } from "../src/exec-image.ts";
import { grown_memory } from "./fixtures/grown-memory.ts";

for (const address of ["i32", "i64"] as const) {
  const pointer = (value: number) => (address === "i64" ? BigInt(value) : value);
  test(`${address}: exec chunks refresh a stale shared kernel view without growing it`, () => {
    const kernel = grown_memory(address);
    new Uint8Array(kernel.live()).set([1, 2, 3, 4], 90000);
    const pending = new Uint8Array(4);
    assert.equal(write_exec_image(pending, kernel.memory, pointer(90000), 0, 4), 0);
    assert.deepEqual([...pending], [1, 2, 3, 4]);
    assert.equal(kernel.calls.length, 1);
    assert.equal(kernel.live().byteLength, 131072);
  });
  test(`${address}: exec chunks are all-or-nothing and remain usable after refusal`, () => {
    const kernel = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const pending = new Uint8Array(8).fill(23);
    new Uint8Array(kernel.buffer, 8, 4).set([1, 2, 3, 4]);
    assert.equal(write_exec_image(null, kernel, pointer(8), 0, 4), -22);
    for (const [source, offset, length] of [
      [65534, 0, 4],
      [8, 6, 4],
      [8, -1, 4],
      [8, 0, -1],
      [8, 0x100000000, 4],
      [8, 0, 0.5],
      [-1, 0, 4],
    ] as const) {
      assert.equal(write_exec_image(pending, kernel, pointer(source), offset, length), -22);
      assert.deepEqual([...pending], Array(8).fill(23));
    }
    if (address === "i64") {
      assert.equal(write_exec_image(pending, kernel, 0x100000008n, 0, 4), -22);
      assert.deepEqual(
        [...pending],
        Array(8).fill(23),
        "memory64 source must not wrap to offset 8",
      );
    }
    assert.equal(write_exec_image(pending, kernel, pointer(8), 4, 4), 0);
    assert.deepEqual([...pending], [23, 23, 23, 23, 1, 2, 3, 4]);
    // Recreate the view each time: a later kernel memory growth is visible.
    kernel.grow(1);
    new Uint8Array(kernel.buffer, 65536, 4).set([5, 6, 7, 8]);
    assert.equal(write_exec_image(pending, kernel, pointer(65536), 0, 4), 0);
    assert.deepEqual([...pending], [5, 6, 7, 8, 1, 2, 3, 4]);
    assert.equal(write_exec_image(pending, kernel, pointer(131072), 8, 0), 0);
    assert.equal(write_exec_image(pending, kernel, pointer(131073), 8, 0), -22);
    assert.equal(
      write_exec_image(pending, kernel, pointer(0), 0, 1),
      0,
      "kernel offset zero is not subject to user NULL-pointer policy",
    );
    assert.equal(pending[0], 0);
  });
}

test("a real Wasm32 compile_write import rejects high source/u32 fields without trapping", () => {
  const string = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
  const body = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x10, 0, 0x0b];
  const module = new WebAssembly.Module(
    new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      ...section(1, [1, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
      ...section(2, [1, ...string("user"), ...string("compile_write"), 0, 0]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...string("write"), 0, 1]),
      ...section(10, [1, body.length, ...body]),
    ]),
  );
  const kernel = new WebAssembly.Memory({ initial: 1 });
  const pending = new Uint8Array(8).fill(23);
  let seen: number[] = [];
  const instance = new WebAssembly.Instance(module, {
    user: {
      compile_write(source: number, offset: number, length: number) {
        seen = [source, offset, length];
        return write_exec_image(pending, kernel, source, offset, length);
      },
    },
  });
  const write = instance.exports.write as CallableFunction;
  for (const args of [
    [0x80000040, 0, 4],
    [8, 0x80000000, 4],
    [8, 0, 0xffffffff],
  ]) {
    assert.equal(write(...args), -22);
    assert.ok(
      seen.some((value) => value < 0),
      "the raw import received signed i32 values",
    );
    assert.deepEqual([...pending], Array(8).fill(23));
  }
  new Uint8Array(kernel.buffer, 8, 4).set([1, 2, 3, 4]);
  assert.equal(write(8, 0, 4), 0);
  assert.deepEqual([...pending], [1, 2, 3, 4, 23, 23, 23, 23]);
});
