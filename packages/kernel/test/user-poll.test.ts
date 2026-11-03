// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { call_user_poll } from "../src/user-poll.ts";
import { call_kernel_entry } from "../src/signal-stack.ts";
import { user_module_imports_supported, type Instance } from "../src/wasm.ts";

for (const address of ["i32", "i64"] as const) {
  test(`${address}: user checkpoints defer live callbacks and restore nonlocal kernel state`, () => {
    const word = (n: number) => (address === "i64" ? BigInt(n) : n);
    const stack = () => new WebAssembly.Global({ value: address, mutable: true }, word(128));
    const memory = new WebAssembly.Memory({ initial: 1 });
    const user = { __stack_pointer: stack() };
    let phase = 1,
      calls = 0,
      fail = false;
    const jump = Symbol("nonlocal handler jump");
    const kernel = {
      __stack_pointer: stack(),
      user_context_v1(mode: number) {
        const old = phase;
        if (mode !== 2) phase = mode;
        return old;
      },
      user_poll_v1() {
        calls++;
        assert.equal(call_user_poll(kernel, user, memory, address, false), 0);
        if (fail) {
          kernel.__stack_pointer!.value = word(64);
          phase = 0;
          throw jump;
        }
        return 0;
      },
    } as unknown as Instance["exports"];
    assert.equal(call_user_poll(kernel, user, memory, address, false), 0);
    assert.equal(calls, 1);
    assert.equal(call_user_poll(kernel, user, memory, address, true), 0);
    call_kernel_entry(kernel, address, () => {
      assert.equal(call_user_poll(kernel, user, memory, address, false), 0);
    });
    assert.equal(calls, 1);
    fail = true;
    assert.throws(
      () => call_user_poll(kernel, user, memory, address, false),
      (error) => error === jump,
    );
    assert.equal(kernel.__stack_pointer!.value, word(128));
    assert.equal(phase, 1);
    fail = false;
    assert.equal(call_user_poll(kernel, user, memory, address, false), 0);
    assert.equal(calls, 3);
    user.__stack_pointer.value = word(65537);
    assert.equal(call_user_poll(kernel, user, memory, address, false), -14);
    assert.equal(calls, 3);
    user.__stack_pointer.value = word(128);
    phase = 0;
    assert.equal(call_user_poll(kernel, user, memory, address, false), -11);
    phase = 1;
    assert.equal(
      call_user_poll({ ...kernel, user_poll_v1: undefined }, user, memory, address, false),
      -95,
    );
    assert.throws(
      () => call_user_poll({ ...kernel, user_poll_v1: () => NaN }, user, memory, address, false),
      /invalid user poll/,
    );
  });
}

test("poll module admission requires explicit ABI/globals and rejects fork/dynamic combinations", () => {
  const text = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
  const leb = (n: number): number[] => (n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)]);
  for (const variant of ["normal", "no-abi", "fork", "dynamic", "unknown"] as const) {
    const imports = [
      ...text("linux_user_poll_v1"),
      ...text(variant === "unknown" ? "future" : "checkpoint"),
      0,
      0,
      ...(variant === "dynamic" ? [...text("linux_dlopen_v1"), ...text("abi"), 0, 0] : []),
    ];
    const exports = [
      ...text("__tls_base"),
      3,
      0,
      ...text("__stack_pointer"),
      3,
      1,
      ...(variant !== "no-abi" ? [...text("__wasm_user_poll_abi"), 0, 0] : []),
      ...(variant === "fork" ? [...text("__wasm_fork_abi"), 0, 0] : []),
    ];
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
        ...section(1, [1, 0x60, 0, 1, 0x7f]),
        ...section(2, [variant === "dynamic" ? 2 : 1, ...imports]),
        ...section(6, [2, 0x7f, 1, 0x41, 0, 0x0b, 0x7f, 1, 0x41, 0, 0x0b]),
        ...section(7, [variant === "no-abi" ? 2 : variant === "fork" ? 4 : 3, ...exports]),
      ]),
    );
    assert.equal(user_module_imports_supported(module), variant === "normal", variant);
  }
});
