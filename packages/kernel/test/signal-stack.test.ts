// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { allocate_shared_memory } from "../src/wasm.ts";
import {
  read_signal_stack_pointer,
  call_on_signal_stack,
  call_kernel_entry,
  call_signal_callback,
} from "../src/signal-stack.ts";

test("signal callback cleanup retires only its frame, preserves SjLj, and skips a dead task", () => {
  const halt = Symbol("task handed CPU away");
  const jump = new WebAssembly.Exception(new WebAssembly.Tag({ parameters: [] }), []);
  const frames = ["outer"];
  const cleanup = () => {
    frames.pop();
  };
  call_signal_callback(
    () => {
      frames.push("inner");
      assert.throws(
        () =>
          call_signal_callback(
            () => {
              throw jump;
            },
            cleanup,
            halt,
          ),
        (error) => error === jump,
      );
      assert.deepEqual(frames, ["outer"]);
    },
    cleanup,
    halt,
  );
  assert.deepEqual(frames, []);
  assert.throws(
    () =>
      call_signal_callback(
        () => {
          throw halt;
        },
        () => assert.fail("must not enter C after task exit"),
        halt,
      ),
    (error) => error === halt,
  );
  let calls = 0;
  assert.equal(
    call_signal_callback(
      () => 17,
      () => calls++,
      halt,
    ),
    17,
  );
  assert.equal(calls, 1);
});

for (const address of ["i32", "i64"] as const) {
  const p = (n: number) => (address === "i64" ? BigInt(n) : n);
  test(`${address}: real mutable integer stack, nested switching and exception unwind`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const global = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    const exports = { __stack_pointer: global };
    assert.equal(read_signal_stack_pointer(exports, memory, address), p(60000));
    assert.equal(
      call_on_signal_stack(exports, memory, address, p(17408), p(1024), p(16384), 3, () => {
        assert.equal(global.value, p(17408));
        assert.equal(
          call_on_signal_stack(exports, memory, address, p(40960), p(32768), p(8192), 2, () => {
            assert.equal(global.value, p(40960));
            return 7;
          }),
          7,
        );
        assert.equal(global.value, p(17408));
        return 0;
      }),
      0,
    );
    assert.equal(global.value, p(60000));
    const jump = new Error("SjLj propagates to its compiler catchpad");
    assert.throws(
      () =>
        call_on_signal_stack(exports, memory, address, p(17408), p(1024), p(16384), 2, () => {
          throw jump;
        }),
      (error) => error === jump,
    );
    assert.equal(global.value, p(60000));
  });
  test(`${address}: missing/immutable/wrong global types and invalid regions refuse before call`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    for (const global of [
      undefined,
      new WebAssembly.Global({ value: address }, p(60000)),
      new WebAssembly.Global({ value: "f64", mutable: true }, 60000),
      new WebAssembly.Global(
        { value: address === "i32" ? "i64" : "i32", mutable: true },
        address === "i32" ? 60000n : 60000,
      ),
    ]) {
      const exports: WebAssembly.Exports = global ? { __stack_pointer: global } : {};
      assert.equal(read_signal_stack_pointer(exports, memory, address), null);
      assert.equal(
        call_on_signal_stack(exports, memory, address, p(17408), p(1024), p(16384), 2, () => {
          throw new Error("called");
        }),
        -95,
      );
    }
    const global = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    const exports = { __stack_pointer: global };
    for (const [top, base, size] of [
      [17408, 0, 17408],
      [17409, 1024, 16385],
      [1024, 1024, 16384],
      [70000, 1024, 69000],
      [17408, 1024, 0],
    ] as const)
      assert.equal(
        call_on_signal_stack(exports, memory, address, p(top), p(base), p(size), 2, () => {
          throw new Error("called");
        }),
        -14,
      );
    assert.equal(
      call_on_signal_stack(exports, memory, address, p(17408), p(1024), p(16384), 4, () => {
        throw new Error("called");
      }),
      -22,
    );
    assert.equal(global.value, p(60000));
    assert.equal(
      call_on_signal_stack({}, memory, address, p(0), p(0), p(0), 0, () => 19),
      19,
    );
    global.value = p(70000);
    assert.equal(read_signal_stack_pointer(exports, memory, address), null);
  });
  test(`${address}: exec replacement is not overwritten while the old callback unwinds`, () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const old = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    const replacement = new WebAssembly.Global({ value: address, mutable: true }, p(50000));
    let current = old;
    call_on_signal_stack(
      { __stack_pointer: old },
      memory,
      address,
      p(17408),
      p(1024),
      p(16384),
      2,
      () => {
        current = replacement;
        return 0;
      },
    );
    assert.equal(old.value, p(60000));
    assert.equal(current.value, p(50000));
  });
  test(`${address}: repeated non-local kernel exits restore each invocation's C stack`, () => {
    const global = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    const exports = { __stack_pointer: global };
    const jump = new Error("non-local user exit");
    for (let i = 0; i < 32; i++) {
      assert.throws(
        () =>
          call_kernel_entry(exports, address, () => {
            global.value = p(59000);
            assert.throws(
              () =>
                call_kernel_entry(exports, address, () => {
                  global.value = p(58000);
                  throw jump;
                }),
              (error) => error === jump,
            );
            assert.equal(global.value, p(59000));
            throw jump;
          }),
        (error) => error === jump,
      );
      assert.equal(global.value, p(60000));
    }
    assert.equal(
      call_kernel_entry({}, address, () => 12),
      12,
    );
  });
  test(`${address}: refresh a stale shared-memory wrapper before rejecting a remotely grown stack`, () => {
    const { memory } = allocate_shared_memory(1, 3, undefined, address);
    const realBuffer = Object.getOwnPropertyDescriptor(
      WebAssembly.Memory.prototype,
      "buffer",
    )!.get!;
    const realGrow = WebAssembly.Memory.prototype.grow as unknown as (
      delta: number | bigint,
    ) => number | bigint;
    const original = realBuffer.call(memory) as SharedArrayBuffer;
    let stale = original;
    realGrow.call(memory, p(1));
    Object.defineProperty(memory, "buffer", { get: () => stale });
    Object.defineProperty(memory, "grow", {
      value(delta: number | bigint) {
        const result = realGrow.call(memory, delta);
        stale = realBuffer.call(memory) as SharedArrayBuffer;
        return result;
      },
    });
    const global = new WebAssembly.Global({ value: address, mutable: true }, p(100000));
    const exports = { __stack_pointer: global };
    assert.equal(read_signal_stack_pointer(exports, memory, address), p(100000));
    stale = original;
    assert.equal(
      call_on_signal_stack(exports, memory, address, p(114688), p(98304), p(16384), 2, () => 0),
      0,
    );
    assert.equal(global.value, p(100000));
    assert.equal(memory.buffer.byteLength, 131072);
  });
}
