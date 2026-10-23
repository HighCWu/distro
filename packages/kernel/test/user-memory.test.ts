// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { allocate_shared_memory } from "../src/wasm.ts";
import { grown_memory } from "./fixtures/grown-memory.ts";
import {
  read_user_memory,
  write_user_memory,
  clear_user_memory,
  user_atomic_word,
} from "../src/user-memory.ts";

test("real i32 size_t imports return residue without allocating or copying a huge range", () => {
  const string = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
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
      ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
      ...section(2, [1, ...string("env"), ...string("copy"), 0, 0]),
      ...section(3, [1, 0]),
      ...section(7, [1, ...string("copy"), 0, 1]),
      ...section(10, [1, 6, 0, 0x20, 0, 0x10, 0, 0x0b]),
    ]),
  );
  const kernel = new WebAssembly.Memory({ initial: 1 });
  const user = new WebAssembly.Memory({ initial: 1 });
  for (const operation of ["read", "write", "clear"] as const) {
    let seen = 0;
    const instance = new WebAssembly.Instance(module, {
      env: {
        copy(length: number) {
          seen = length;
          if (operation === "read") return read_user_memory(kernel, 8, user, 65534, length);
          if (operation === "write") return write_user_memory(user, 65534, kernel, 8, length);
          return clear_user_memory(user, 65534, length);
        },
      },
    });
    for (const length of [0x80000000, 0xffffffff]) {
      const k = new Uint8Array(kernel.buffer),
        u = new Uint8Array(user.buffer);
      k.fill(19);
      u.fill(23);
      const result = (instance.exports.copy as CallableFunction)(length);
      assert.equal(seen, length - 0x100000000);
      assert.equal(result >>> 0, length - (operation === "clear" ? 2 : 0));
      assert.ok(k.every((value) => value === 19));
      assert.ok(u.subarray(0, 65534).every((value) => value === 23));
      assert.deepEqual([...u.subarray(65534)], operation === "clear" ? [0, 0] : [23, 23]);
    }
  }
});

for (const address of ["i32", "i64"] as const) {
  const p = (value: number) => (address === "i64" ? BigInt(value) : value);
  test(`${address}: stale shared user/kernel wrappers refresh before choosing a copy prefix`, () => {
    const user = grown_memory(address),
      kernel = grown_memory(address);
    const liveUser = new Uint8Array(user.live()),
      liveKernel = new Uint8Array(kernel.live());
    liveUser.set([11, 22, 33, 44], 65534);
    assert.equal(read_user_memory(kernel.memory, p(8), user.memory, p(65534), p(4)), 0);
    assert.deepEqual([...liveKernel.slice(8, 12)], [11, 22, 33, 44]);
    assert.equal(user.calls.length, 1);
    assert.equal(kernel.calls.length, 0, "in-range wrappers need no refresh");
    user.stale();
    liveKernel.set([51, 52, 53, 54], 90000);
    assert.equal(write_user_memory(user.memory, p(90000), kernel.memory, p(90000), p(4)), 0);
    assert.deepEqual([...liveUser.slice(90000, 90004)], [51, 52, 53, 54]);
    user.stale();
    assert.equal(clear_user_memory(user.memory, p(90000), p(4)), 0);
    assert.deepEqual([...liveUser.slice(90000, 90004)], [0, 0, 0, 0]);
    user.stale();
    const word = user_atomic_word(user.memory, p(90000));
    assert.ok(word);
    assert.equal(Atomics.exchange(word, 0, 73), 0);
    assert.equal(new DataView(user.live()).getInt32(90000, true), 73);
    assert.equal(user.live().byteLength, 131072);
    assert.equal(kernel.live().byteLength, 131072);
    user.stale();
    user.disable();
    liveKernel.fill(99, 8, 12);
    assert.equal(read_user_memory(kernel.memory, p(8), user.memory, p(65534), p(4)), 2);
    assert.deepEqual([...liveKernel.slice(8, 12)], [11, 22, 99, 99]);
    assert.equal(user_atomic_word(user.memory, p(90000)), null);
  });
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
    for (const pointer of [-1, 65536]) {
      assert.equal(read_user_memory(kernel, p(8), user, p(pointer), p(4)), 4);
      assert.equal(write_user_memory(user, p(pointer), kernel, p(8), p(4)), 4);
      assert.equal(clear_user_memory(user, p(pointer), p(4)), 4);
      assert.equal(read_user_memory(kernel, p(pointer), user, p(8), p(4)), 4);
      assert.equal(write_user_memory(user, p(8), kernel, p(pointer), p(4)), 4);
    }
  });
  test(`${address}: crossing user-memory end copies only the valid prefix and reports residue`, () => {
    const kernel = new WebAssembly.Memory({ initial: 1 });
    const user = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    const k = new Uint8Array(kernel.buffer),
      u = new Uint8Array(user.buffer);
    k.fill(19);
    u.fill(23);
    u.set([65, 66], 65534);
    assert.equal(read_user_memory(kernel, p(8), user, p(65534), p(4)), 2);
    assert.deepEqual([...k.subarray(8, 12)], [65, 66, 19, 19]);
    k.set([71, 72, 73, 74], 8);
    assert.equal(write_user_memory(user, p(65534), kernel, p(8), p(4)), 2);
    assert.deepEqual([...u.subarray(65533)], [23, 71, 72]);
    assert.equal(clear_user_memory(user, p(65534), p(4)), 2);
    assert.deepEqual([...u.subarray(65533)], [23, 0, 0]);
    // A malformed kernel-side range is not permission to touch user bytes.
    assert.equal(read_user_memory(kernel, p(65534), user, p(8), p(4)), 4);
    assert.equal(write_user_memory(user, p(8), kernel, p(65534), p(4)), 4);
    assert.deepEqual([...u.subarray(8, 12)], [23, 23, 23, 23]);
    user.grow(1);
    new Uint8Array(user.buffer).set([81, 82, 83, 84], 65534);
    assert.equal(
      read_user_memory(kernel, p(8), user, p(65534), p(4)),
      0,
      "each call observes the current memory extent, not a stale pre-grow view",
    );
    assert.deepEqual([...k.subarray(8, 12)], [81, 82, 83, 84]);
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
  test(`${address}: Wasm memory.grow exposes the new extent to the next user copy`, () => {
    const { memory } = allocate_shared_memory(1, 3, undefined, address);
    const string = (value: string) => [value.length, ...new TextEncoder().encode(value)];
    const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
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
        ...section(1, [1, 0x60, 0, 1, address === "i64" ? 0x7e : 0x7f]),
        ...section(2, [
          1,
          ...string("env"),
          ...string("memory"),
          2,
          address === "i64" ? 7 : 3,
          1,
          3,
        ]),
        ...section(3, [1, 0]),
        ...section(7, [1, ...string("grow"), 0, 0]),
        ...section(10, [1, 6, 0, address === "i64" ? 0x42 : 0x41, 1, 0x40, 0, 0x0b]),
      ]),
    );
    const instance = new WebAssembly.Instance(module, { env: { memory } });
    const kernel = new WebAssembly.Memory({ initial: 1 });
    assert.equal(read_user_memory(kernel, p(8), memory, p(65534), p(4)), 2);
    assert.equal((instance.exports.grow as CallableFunction)(), p(1));
    assert.equal(memory.buffer.byteLength, 131072);
    new Uint8Array(memory.buffer).set([91, 92, 93, 94], 65534);
    assert.equal(read_user_memory(kernel, p(8), memory, p(65534), p(4)), 0);
    assert.deepEqual([...new Uint8Array(kernel.buffer, 8, 4)], [91, 92, 93, 94]);
  });
}
