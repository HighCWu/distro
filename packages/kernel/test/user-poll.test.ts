// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  call_user_poll,
  user_poll_thread,
  call_fork_child_return,
  fork_child_return_supported,
} from "../src/user-poll.ts";
import { call_kernel_entry, call_user_callback } from "../src/signal-stack.ts";
import { user_module_imports_supported, type Instance } from "../src/wasm.ts";

for (const address of ["i32", "i64"] as const) {
  test(`${address}: mandatory fork return work cannot silently defer startup callbacks`, () => {
    const word = (n: number) => (address === "i64" ? BigInt(n) : n);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const user = {
      __stack_pointer: new WebAssembly.Global({ value: address, mutable: true }, word(128)),
    };
    let phase = 1,
      polls = 0;
    const transfer = Symbol("child signal control transfer");
    let fail = false;
    const kernel = {
      user_context_v1(mode: number) {
        const old = phase;
        if (mode !== 2) phase = mode;
        return old;
      },
      user_poll_v1() {
        polls++;
        assert.equal(call_fork_child_return(kernel, user, memory, address), -16);
        if (fail) throw transfer;
        return 0;
      },
      syscall() {
        throw new Error("return work must never manufacture a syscall");
      },
    } as unknown as Instance["exports"];
    assert.equal(fork_child_return_supported(kernel), true);
    assert.equal(fork_child_return_supported({ user_context_v1: kernel.user_context_v1! }), false);
    assert.equal(fork_child_return_supported({ ...kernel, user_context_v1: () => 1 }), false);
    assert.equal(call_fork_child_return(kernel, user, memory, address), 0);
    assert.equal(polls, 1);
    call_kernel_entry(kernel, address, () =>
      assert.equal(call_fork_child_return(kernel, user, memory, address), -16),
    );
    call_user_callback(kernel, address, () =>
      assert.equal(call_fork_child_return(kernel, user, memory, address), -16),
    );
    assert.equal(polls, 1);
    phase = 0;
    assert.equal(call_fork_child_return(kernel, user, memory, address), -11);
    phase = 1;
    fail = true;
    assert.throws(
      () => call_fork_child_return(kernel, user, memory, address),
      (error) => error === transfer,
    );
    assert.equal(polls, 2);
    assert.equal(phase, 1);
  });

  test(`${address}: thread readiness starts empty and publishes only the kernel-owned TP`, () => {
    const word = (n: number) => (address === "i64" ? BigInt(n) : n);
    let current = word(17),
      reads = 0,
      fail = false;
    const read = () => {
      reads++;
      if (fail) throw new Error("kernel TP unavailable");
      return current;
    };
    const first = user_poll_thread(address, read),
      second = user_poll_thread(address, read);
    assert.equal(reads, 0);
    assert.equal(first.global.value, word(0));
    first.refresh();
    assert.equal(first.global.value, word(17));
    assert.equal(second.global.value, word(0));
    current = word(23);
    second.refresh();
    assert.equal(first.global.value, word(17));
    assert.equal(second.global.value, word(23));
    assert.throws(
      () =>
        first.suspend(() => {
          assert.equal(first.global.value, word(0));
          first.publish(word(99));
          first.refresh();
          first.suspend(() => assert.equal(first.global.value, word(0)));
          assert.equal(first.global.value, word(0));
          throw new Error("callback unwind");
        }),
      /callback unwind/,
    );
    assert.equal(first.global.value, word(17));
    fail = true;
    assert.throws(() => first.refresh(), /TP unavailable/);
    assert.equal(first.global.value, word(17));
    fail = false;
    current = word(0);
    first.refresh();
    assert.equal(first.global.value, word(0));
  });
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
  test(`${address}: handler nesting requires capability and never crosses an allocator callback`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const user = {
      __stack_pointer: new WebAssembly.Global(
        { value: address, mutable: true },
        address === "i64" ? 128n : 128,
      ),
    };
    let calls = 0,
      phase = 1;
    const kernel = {
      user_context_v1(mode: number) {
        const old = phase;
        if (mode !== 2) phase = mode;
        return old;
      },
      user_poll_v1() {
        calls++;
        return 0;
      },
    } as unknown as Instance["exports"];
    const enter = () =>
      call_kernel_entry(kernel, address, () =>
        call_user_poll(kernel, user, memory, address, false, true),
      );
    for (const capability of [undefined, () => 0, () => 2, (_unused: number) => 1]) {
      kernel.user_poll_nested_v1 = capability as (() => number) | undefined;
      assert.equal(enter(), 0);
      assert.equal(calls, 0);
    }
    kernel.user_poll_nested_v1 = () => 1;
    assert.equal(enter(), 0);
    assert.equal(calls, 1);
    const jump = Symbol("allocator left nonlocally");
    assert.throws(
      () =>
        call_user_callback(kernel, address, () => {
          assert.equal(enter(), 0);
          assert.equal(calls, 1);
          throw jump;
        }),
      (error) => error === jump,
    );
    assert.equal(enter(), 0);
    assert.equal(calls, 2, "callback marker is cleared after nonlocal exit");
  });
}

test("poll admission requires explicit ABI/globals and a separate fork composition marker", () => {
  const text = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
  const leb = (n: number): number[] => (n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)]);
  const dynamic_exports = [
    "__wasm_dlopen_io_v1",
    "__wasm_dlopen_read",
    "__wasm_dlopen_read_release",
    "__wasm_dlopen_origin",
    "__wasm_dlopen_fd",
    "__wasm_dlopen_allocate",
    "__wasm_dlopen_deallocate",
    "__wasm_dlopen_library_path",
  ] as const;
  for (const variant of [
    "normal",
    "no-abi",
    "fork",
    "fork-poll",
    "dynamic-incomplete",
    "dynamic-poll",
    "unknown",
  ] as const) {
    const has_dynamic_import = variant === "dynamic-incomplete" || variant === "dynamic-poll";
    const imports = [
      ...text("linux_user_poll_v1"),
      ...text(variant === "unknown" ? "future" : "checkpoint"),
      0,
      0,
      ...(has_dynamic_import ? [...text("linux_dlopen_v1"), ...text("abi"), 0, 0] : []),
    ];
    const exports = [
      ...text("__tls_base"),
      3,
      0,
      ...text("__stack_pointer"),
      3,
      1,
      ...(variant !== "no-abi" ? [...text("__wasm_user_poll_abi"), 0, 0] : []),
      ...(["fork", "fork-poll"].includes(variant) ? [...text("__wasm_fork_abi"), 0, 0] : []),
      ...(variant === "fork-poll" ? [...text("__wasm_fork_user_poll_abi"), 0, 0] : []),
      ...(variant === "dynamic-poll"
        ? dynamic_exports.flatMap((name) => [...text(name), 0, 1])
        : []),
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
        ...section(2, [has_dynamic_import ? 2 : 1, ...imports]),
        ...section(6, [2, 0x7f, 1, 0x41, 0, 0x0b, 0x7f, 1, 0x41, 0, 0x0b]),
        ...section(7, [
          variant === "dynamic-poll"
            ? 3 + dynamic_exports.length
            : variant === "no-abi"
              ? 2
              : variant === "fork"
                ? 4
                : variant === "fork-poll"
                  ? 5
                  : 3,
          ...exports,
        ]),
      ]),
    );
    assert.equal(
      user_module_imports_supported(module),
      variant === "normal" || variant === "fork-poll" || variant === "dynamic-poll",
      variant,
    );
  }
});

test("poll ABI2 admission requires both imports and refuses mixed execution versions", () => {
  const text = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  const leb = (n: number): number[] => (n < 128 ? [n] : [(n & 127) | 128, ...leb(n >>> 7)]);
  const section = (id: number, bytes: number[]) => [id, ...leb(bytes.length), ...bytes];
  for (const variant of [
    "normal",
    "fork",
    "fork-no-marker",
    "fork-global-marker",
    "fork-mixed",
    "no-tp",
    "no-checkpoint",
    "mixed",
    "future",
  ] as const) {
    const imports: number[][] = [];
    let functions = 0;
    if (variant !== "no-checkpoint") {
      imports.push([...text("linux_user_poll_v2"), ...text("checkpoint"), 0, 0]);
      functions++;
    }
    if (variant !== "no-tp")
      imports.push([...text("linux_user_poll_v2"), ...text("thread_pointer"), 3, 0x7f, 1]);
    if (variant === "mixed" || variant === "fork-mixed" || variant === "future") {
      imports.push([
        ...text(variant === "future" ? "linux_user_poll_v3" : "linux_user_poll_v1"),
        ...text("checkpoint"),
        0,
        0,
      ]);
      functions++;
    }
    if (variant.startsWith("fork")) {
      imports.push([...text("linux_fork_v1"), ...text("checkpoint"), 0, 0]);
      functions++;
    }
    const offset = variant === "no-tp" ? 0 : 1;
    const exports = [
      ...text("__wasm_user_poll_abi"),
      0,
      functions,
      ...text("__tls_base"),
      3,
      offset,
      ...text("__stack_pointer"),
      3,
      offset + 1,
    ];
    let exportCount = 3;
    if (variant === "fork" || variant === "fork-mixed") {
      exports.push(...text("__wasm_fork_user_poll_abi"), 0, functions);
      exportCount++;
    } else if (variant === "fork-global-marker") {
      exports.push(...text("__wasm_fork_user_poll_abi"), 3, offset);
      exportCount++;
    }
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
        ...section(2, [imports.length, ...imports.flat()]),
        ...section(3, [1, 0]),
        ...section(6, [2, 0x7f, 1, 0x41, 0, 0x0b, 0x7f, 1, 0x41, 0, 0x0b]),
        ...section(7, [exportCount, ...exports]),
        ...section(10, [1, 4, 0, 0x41, 2, 0x0b]),
      ]),
    );
    assert.equal(
      user_module_imports_supported(module),
      variant === "normal" || variant === "fork",
      variant,
    );
  }
});
