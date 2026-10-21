// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  read_user_memory,
  write_user_memory,
  clear_user_memory,
  user_atomic_word,
} from "../src/user-memory.ts";

for (const address of ["i32", "i64"] as const) {
  const p = (value: number) => (address === "i64" ? BigInt(value) : value);
  test(`${address}: NULL user copy is rejected without mutating either memory`, () => {
    const kernel = new WebAssembly.Memory({ initial: 1 });
    const user = new WebAssembly.Memory({ initial: 1 });
    const k = new Uint8Array(kernel.buffer),
      u = new Uint8Array(user.buffer);
    k.fill(11);
    u.fill(23);
    assert.equal(read_user_memory(kernel, p(8), user, p(0), p(4)), 4);
    assert.equal(write_user_memory(user, p(0), kernel, p(8), p(4)), 4);
    assert.equal(clear_user_memory(user, p(0), p(4)), 4);
    assert.ok(k.every((value) => value === 11));
    assert.ok(u.every((value) => value === 23));
    // Kernel address 0 is independent of a user NULL; do not modify the generic
    // memory_bytes primitive, which boot and kernel internals legitimately use.
    assert.equal(read_user_memory(kernel, p(0), user, p(8), p(4)), 0);
    assert.deepEqual([...k.subarray(0, 4)], [23, 23, 23, 23]);
    assert.equal(write_user_memory(user, p(12), kernel, p(0), p(4)), 0);
    assert.deepEqual([...u.subarray(12, 16)], [23, 23, 23, 23]);
    assert.equal(clear_user_memory(user, p(65532), p(4)), 0);
    assert.deepEqual([...u.subarray(65532)], [0, 0, 0, 0]);
  });
  test(`${address}: zero length ignores pointers; bad ranges return full residue`, () => {
    const kernel = new WebAssembly.Memory({ initial: 1 });
    const user = new WebAssembly.Memory({ initial: 1 });
    for (const pointer of [0, -1, 65537]) {
      assert.equal(read_user_memory(kernel, p(pointer), user, p(pointer), p(0)), 0);
      assert.equal(write_user_memory(user, p(pointer), kernel, p(pointer), p(0)), 0);
      assert.equal(clear_user_memory(user, p(pointer), p(0)), 0);
    }
    for (const pointer of [-1, 65533]) {
      assert.equal(read_user_memory(kernel, p(8), user, p(pointer), p(4)), 4);
      assert.equal(write_user_memory(user, p(pointer), kernel, p(8), p(4)), 4);
      assert.equal(clear_user_memory(user, p(pointer), p(4)), 4);
      assert.equal(read_user_memory(kernel, p(pointer), user, p(8), p(4)), 4);
      assert.equal(write_user_memory(user, p(8), kernel, p(pointer), p(4)), 4);
    }
  });
  test(`${address}: user atomic words reject NULL, misalignment and bounds without mutation`, () => {
    const user = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
    for (const pointer of [0, 1, -1, 65536]) assert.equal(user_atomic_word(user, p(pointer)), null);
    const last = user_atomic_word(user, p(65532));
    assert.ok(last);
    assert.equal(Atomics.exchange(last, 0, 37), 0);
    assert.equal(new DataView(user.buffer).getInt32(65532, true), 37);
    assert.equal(new DataView(user.buffer).getInt32(0, true), 0);
  });
}
