// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { allocate_shared_memory, HALT_KERNEL } from "../src/wasm.ts";
import {
  read_signal_stack_pointer,
  call_on_signal_stack,
  call_kernel_entry,
  call_signal_callback,
  call_plain_signal_handler,
  call_user_callback,
} from "../src/signal-stack.ts";

test("plain signal trampoline preserves pointer width, exceptions and old modules", () => {
  for (const fn of [123, 0x100000000n]) {
    let calls = 0;
    const exports = {
      __wasm_signal_handler_v2: (entry: number | bigint, sig: number) => {
        assert.equal(entry, fn);
        assert.equal(sig, 10);
        calls++;
        return 7;
      },
    };
    assert.equal(
      call_plain_signal_handler(exports, fn, 10, () => assert.fail("new trampoline required")),
      7,
    );
    assert.equal(calls, 1);
    assert.equal(
      call_plain_signal_handler({}, fn, 10, () => 9),
      9,
    );
  }
  const jump = new Error("non-local exit must propagate");
  assert.throws(
    () =>
      call_plain_signal_handler(
        {
          __wasm_signal_handler_v2: (_fn: number, _sig: number) => {
            throw jump;
          },
        },
        1,
        10,
        () => {},
      ),
    (e) => e === jump,
  );
  assert.throws(
    () => call_plain_signal_handler({ __wasm_signal_handler_v2: () => {} }, 1, 10, () => {}),
    /Invalid plain/,
  );
});

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
  test(`${address}: callbacks, leaf imports and non-local syscalls restore their caller phase`, () => {
    const stack = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    let phase = 1;
    const transitions: number[] = [];
    const irqCallers: number[] = [];
    const exports = {
      __stack_pointer: stack,
      callback_irq_save_v1() {
        irqCallers.push(phase);
        return 1;
      },
      callback_irq_restore_v1(_flags: number) {
        assert.equal(phase, irqCallers.pop(), "restore phase before a live caller's IRQ state");
      },
      user_context_v1(mode: number) {
        const previous = phase;
        if (mode !== 2) {
          phase = mode;
          transitions.push(mode);
        }
        return previous;
      },
    };
    const jump = new WebAssembly.Exception(new WebAssembly.Tag({ parameters: [] }), []);
    const exec = Symbol("replace user image, not a dead task");
    for (const error of [undefined, jump, exec, HALT_KERNEL]) {
      phase = 1;
      transitions.length = 0;
      irqCallers.length = 0;
      const invoke = () =>
        call_kernel_entry(exports, address, () => {
          phase = 0; // ordinary syscall's generic entry
          stack.value = p(59000);
          return call_user_callback(exports, address, () => {
            assert.equal(phase, 1);
            call_kernel_entry(
              exports,
              address,
              () => {
                assert.equal(phase, 0, "leaf imports must enter kernel context");
              },
              true,
            );
            assert.equal(phase, 1);
            return call_kernel_entry(exports, address, () => {
              phase = 0;
              stack.value = p(58000);
              if (error !== undefined) throw error;
              stack.value = p(59000);
              phase = 1; // nested syscall's generic exit
              return 7;
            });
          });
        });
      if (error === undefined) assert.equal(invoke(), 7);
      else assert.throws(invoke, (value) => value === error);
      if (error === HALT_KERNEL) {
        assert.equal(phase, 0);
        assert.deepEqual(transitions, [1, 0, 1], "no C entry after task hands its CPU away");
      } else {
        assert.equal(phase, 1);
        assert.equal(irqCallers.length, 0);
        assert.ok(transitions.includes(0), "the allocator's kernel caller must be restored");
      }
      if (error !== undefined) assert.equal(stack.value, p(60000));
      stack.value = p(60000);
    }
    assert.equal(
      call_user_callback({}, address, () => 19),
      19,
      "old kernels remain compatible",
    );
    for (const bad of [
      new WebAssembly.Global({ value: "i32" }, 7),
      () => 0,
      (_mode: number) => 2,
    ]) {
      assert.throws(
        () => call_user_callback({ user_context_v1: bad }, address, () => assert.fail()),
        /invalid user context/,
      );
    }
  });
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
  test(`${address}: nested kernel calls restore live callback IRQs, not a dead task`, () => {
    const stack = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    let irq = 0,
      saves = 0,
      restores = 0;
    const exports = {
      __stack_pointer: stack,
      callback_irq_save_v1() {
        saves++;
        return irq;
      },
      callback_irq_restore_v1(flags: number) {
        assert.equal(stack.value, p(60000));
        restores++;
        irq = flags;
      },
    };
    const jump = new WebAssembly.Exception(new WebAssembly.Tag({ parameters: [] }), []);
    for (const enabled of [0, 1])
      for (const failure of [undefined, jump, HALT_KERNEL]) {
        saves = restores = 0;
        stack.value = p(60000);
        call_kernel_entry(exports, address, () => {
          irq = enabled;
          const inner = () =>
            call_kernel_entry(exports, address, () => {
              stack.value = p(58000);
              irq = 1 - enabled;
              if (failure) throw failure;
              stack.value = p(60000); // Normal C return restores its own stack.
              return 17;
            });
          if (failure) assert.throws(inner, (error) => error === failure);
          else assert.equal(inner(), 17);
          assert.equal(saves, 1);
          assert.equal(restores, failure === HALT_KERNEL ? 0 : 1);
          assert.equal(irq, failure === HALT_KERNEL ? 1 - enabled : enabled);
          if (failure) assert.equal(stack.value, p(60000));
        });
      }
    // A top-level invocation after an exception must not inherit stale depth.
    const before = saves;
    call_kernel_entry(exports, address, () => 21);
    assert.equal(saves, before);
  });
  test(`${address}: incomplete and invalid callback IRQ ABI does not partially invoke`, () => {
    const legacy: WebAssembly.Exports[] = [
      { callback_irq_save_v1: () => assert.fail("must not invoke half an IRQ ABI") },
      { callback_irq_restore_v1: () => assert.fail() },
    ];
    for (const exports of legacy) {
      assert.equal(
        call_kernel_entry(exports, address, () => call_kernel_entry(exports, address, () => 7)),
        7,
      );
    }
    let called = 0;
    const exports = { callback_irq_save_v1: () => 2, callback_irq_restore_v1: () => assert.fail() };
    call_kernel_entry(exports, address, () => {
      assert.throws(
        () => call_kernel_entry(exports, address, () => called++),
        /invalid callback IRQ/,
      );
    });
    assert.equal(called, 0);
    assert.equal(
      call_kernel_entry(exports, address, () => 19),
      19,
    );
  });
  test(`${address}: a trapping IRQ restoration cannot strand a live caller's C stack`, () => {
    const stack = new WebAssembly.Global({ value: address, mutable: true }, p(60000));
    const failure = new Error("kernel IRQ restoration failed");
    const exports = {
      __stack_pointer: stack,
      callback_irq_save_v1: () => 1,
      callback_irq_restore_v1() {
        stack.value = p(58000);
        throw failure;
      },
    };
    call_kernel_entry(exports, address, () => {
      stack.value = p(59000);
      assert.throws(
        () => call_kernel_entry(exports, address, () => 17),
        (error) => error === failure,
      );
      assert.equal(stack.value, p(59000));
      stack.value = p(60000);
    });
    assert.equal(
      call_kernel_entry(exports, address, () => 19),
      19,
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
