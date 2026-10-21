// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { clone3_fork_request } from "../src/clone3-args.ts";

for (const address of ["i32", "i64"] as const)
  test(`${address}: bounded clone3 u64 layout and rejection`, () => {
    const p = (n: number) => (address === "i64" ? BigInt(n) : n);
    const memory = new WebAssembly.Memory({ initial: 2 });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const reset = () => {
      bytes.fill(0);
      view.setBigUint64(256 + 32, 17n, true);
    };
    const parse = (size: number, pointer = 256) =>
      clone3_fork_request(memory, address, p(pointer), p(size));
    reset();
    for (const size of [64, 65, 72, 80, 88, 96, 65536]) assert.equal(parse(size), 0);
    for (const size of [0, 1, 63]) assert.equal(parse(size), -22);
    for (const size of [65537, -1]) assert.equal(parse(size), -7);
    for (const pointer of [0, -1, 131072 - 63]) assert.equal(parse(64, pointer), -14);
    for (const [index, value, error] of [
      [0, 17n, -22],
      [0, 0x100n, -95],
      [0, 0x100000000n, -95],
      [1, 0x100000000n, -95],
      [2, 1n, -95],
      [3, 1n, -95],
      [4, 0n, -95],
      [4, 65n, -22],
      [4, 0x100000011n, -22],
      [5, 1n, -22],
      [6, 1n, -22],
      [7, 1n, -95],
      [8, 1n, -22],
      [9, 1n, -22],
      [10, 1n, -95],
      [11, 1n, -7],
    ] as const) {
      reset();
      view.setBigUint64(256 + index * 8, value, true);
      assert.equal(parse(96), error, `field ${index}`);
    }
    reset();
    view.setBigUint64(256 + 64, 1n, true);
    assert.equal(parse(64), 0, "bytes outside the supplied size are not read");
    reset();
    view.setBigUint64(256 + 40, 1024n, true);
    view.setBigUint64(256 + 48, 16n, true);
    assert.equal(parse(88), -95, "valid alternate stacks remain unsupported");
    assert.equal(
      clone3_fork_request(memory, address, address === "i64" ? 1n << 55n : -8, p(88)),
      -14,
    );
  });
