// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  ForkContinuation,
  dispatch_fork_syscall,
  dispatch_fork_checkpoint,
  fork_continuation_exports_supported,
  uses_fork_continuation,
  resume_fork_parent,
  resume_fork_child,
  type ForkSnapshot,
} from "../src/fork-continuation.ts";
import { user_module_imports_supported } from "../src/wasm.ts";
import type { WasmAddress, WasmAddressType } from "../src/wasm.ts";
import {
  settle_user_copy,
  wait_user_copy,
  USER_COPY_COMPLETE,
  USER_COPY_NO_MEMORY,
  USER_COPY_TRY_AGAIN,
} from "../src/user-copy.ts";

test("legacy modules do not opt in; incomplete continuation modules fail admission", () => {
  const header = [0, 97, 115, 109, 1, 0, 0, 0];
  const legacy = new WebAssembly.Module(new Uint8Array(header));
  assert.equal(uses_fork_continuation(legacy), false);
  assert.equal(fork_continuation_exports_supported(legacy), true);
  const string = (text: string) => [text.length, ...new TextEncoder().encode(text)];
  for (const name of ["checkpoint", "unknown"]) {
    const imports = [1, ...string("linux_fork_v1"), ...string(name), 0, 0];
    const module = new WebAssembly.Module(
      new Uint8Array([...header, 1, 6, 1, 0x60, 1, 0x7f, 1, 0x7f, 2, imports.length, ...imports]),
    );
    assert.equal(uses_fork_continuation(module), true);
    assert.equal(fork_continuation_exports_supported(module), false);
    assert.equal(user_module_imports_supported(module), name === "checkpoint");
  }
});

test("syscall-only modules opt in using the exported ABI, with no private checkpoint import", () => {
  const name = new TextEncoder().encode("__wasm_fork_abi");
  const exported = [1, name.length, ...name, 0, 0];
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
      1,
      5,
      1,
      0x60,
      0,
      1,
      0x7f,
      3,
      2,
      1,
      0,
      7,
      exported.length,
      ...exported,
      10,
      6,
      1,
      4,
      0,
      0x41,
      1,
      0x0b,
    ]),
  );
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.equal(uses_fork_continuation(module), true);
  assert.equal(
    fork_continuation_exports_supported(module),
    false,
    "ABI export alone is insufficient",
  );
});

function fixture(
  address: WasmAddressType,
  syscall = false,
  syscallAbi = 1,
  pidfdSupported = true,
  registers = { stack: 32768, tls: 1024 },
  nativeClone3 = false,
  userPoll = false,
) {
  const pointer = (n: number): WasmAddress => (address === "i64" ? BigInt(n) : n);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  function descriptor(start = 128, end = 4096) {
    if (address === "i64") {
      view.setBigUint64(64, BigInt(start), true);
      view.setBigUint64(72, BigInt(end), true);
    } else {
      view.setUint32(64, start, true);
      view.setUint32(68, end, true);
    }
  }
  descriptor();
  let state = 0;
  const global = (n: number) =>
    new WebAssembly.Global({ value: address, mutable: true }, pointer(n));
  const exports = {
    _start: () => {},
    __wasm_fork_abi: () => 1,
    __wasm_fork_child_entry: () => pointer(7),
    __wasm_fork_clone: () => pointer(1234),
    __stack_pointer: global(registers.stack),
    __tls_base: global(registers.tls),
    asyncify_get_state: () => state,
    asyncify_start_unwind: (_descriptor: WasmAddress) => {
      assert.equal(state, 0);
      state = 1;
    },
    asyncify_stop_unwind: () => {
      assert.equal(state, 1);
      state = 0;
    },
    asyncify_start_rewind: (_descriptor: WasmAddress) => {
      assert.equal(state, 0);
      state = 2;
    },
    asyncify_stop_rewind: () => {
      assert.equal(state, 2);
      state = 0;
    },
  };
  const calls = { descriptors: 0 };
  if (userPoll) Object.assign(exports, { __wasm_fork_user_poll_abi: () => 1 });
  if (syscall)
    Object.assign(exports, {
      __wasm_fork_syscall_abi: () => syscallAbi,
      __wasm_fork_descriptor: () => {
        calls.descriptors++;
        descriptor();
        return pointer(64);
      },
    });
  const controller = new ForkContinuation(
    { exports } as unknown as WebAssembly.Instance,
    memory,
    address,
    undefined,
    pidfdSupported,
    nativeClone3,
  );
  return { controller, exports, memory, pointer, descriptor, calls };
}

for (const address of ["i32", "i64"] as const)
  for (const fatal of [false, true])
    test(`${address}: child return work runs only after rewind and propagates control transfer=${fatal}`, () => {
      const parent = fixture(address, true, 2);
      const child = fixture(address, true, 2, true, undefined, true, false);
      const p = child.pointer;
      assert.equal(parent.controller.syscallCheckpoint(true), 0);
      const snapshot = parent.controller.suspend();
      let calls = 0;
      const transfer = Symbol("fatal child return work");
      const controller = new ForkContinuation(
        { exports: child.exports } as unknown as WebAssembly.Instance,
        child.memory,
        address,
        () => {
          throw new Error("ignored timing diagnostic");
        },
        true,
        true,
        () => {
          calls++;
          assert.equal(child.exports.asyncify_get_state(), 0);
          assert.equal(child.exports.__stack_pointer.value, snapshot.stack);
          assert.equal(child.exports.__tls_base.value, snapshot.tls);
          assert.equal(
            controller.userPollAllowed(),
            false,
            "ordinary fork needs no compiler polling marker",
          );
          controller.kernelCall(() => assert.equal(controller.syscallCheckpoint(true), -95));
          if (fatal) throw transfer;
        },
      );
      controller.resumeChild(snapshot);
      assert.equal(calls, 0, "startup and active rewind defer return work");
      if (fatal)
        assert.throws(
          () => controller.syscallCheckpoint(true),
          (error) => error === transfer,
        );
      else assert.equal(controller.syscallCheckpoint(true), 0);
      assert.equal(calls, 1);
      assert.equal(child.exports.asyncify_get_state(), 0);
      assert.equal(controller.syscallCheckpoint(true), 0, "descriptor was cleared before callback");
      controller.suspend();
      controller.resumeParent(p(-11));
      assert.equal(controller.syscallCheckpoint(true), -11);
      assert.equal(calls, 1, "parent rewind must never repeat child return work");
    });

for (const address of ["i32", "i64"] as const)
  test(`${address}: fork polling requires capability and defers every snapshot transition`, () => {
    assert.equal(fixture(address).controller.userPollAllowed(), false);
    const { controller: c, pointer: p } = fixture(address, false, 1, true, undefined, false, true);
    assert.equal(c.userPollAllowed(), true);
    const jump = Symbol("kernel unwind");
    assert.throws(
      () =>
        c.kernelCall(() => {
          assert.equal(c.userPollAllowed(), false);
          assert.equal(c.userPollAllowed(true), true);
          throw jump;
        }),
      (error) => error === jump,
    );
    assert.equal(c.userPollAllowed(), true);
    assert.equal(c.checkpoint(p(64), true), 0);
    assert.equal(c.userPollAllowed(true), false);
    c.suspend();
    assert.equal(c.userPollAllowed(true), false, "stopped unwind still owns descriptor");
    c.resumeParent(p(-11));
    assert.equal(c.userPollAllowed(true), false);
    assert.equal(c.checkpoint(p(64), true), -11);
    assert.equal(c.userPollAllowed(), true);
  });

for (const address of ["i32", "i64"] as const)
  for (const native of [true, false])
    test(`${address}: ${native ? "clone3" : "clone"} UNTRACED requires explicit support and clears after failure`, () => {
      const {
        controller,
        exports,
        memory,
        pointer: p,
        calls,
      } = fixture(address, true, 2, true, undefined, true);
      const view = new DataView(memory.buffer);
      view.setBigUint64(8192, 0x800000n, true);
      view.setBigUint64(8224, 17n, true);
      let forwarded = 0;
      Object.assign(exports, {
        __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
          assert.ok(native);
          assert.deepEqual(args, [0x800000n, p(0), p(0), p(0)]);
          forwarded++;
          return p(-11);
        },
        __wasm_fork_clone_options: (...args: WasmAddress[]) => {
          assert.ok(!native);
          assert.deepEqual(args, [p(0x800000), p(0), p(0)]);
          forwarded++;
          return p(-11);
        },
      });
      const enter = () =>
        native
          ? controller.clone3Checkpoint(p(8192), p(88), true)
          : controller.cloneCheckpoint([p(0x800011), p(0), p(-1), p(-1), p(-1), p(-1)], true);
      for (const feature of [undefined, 0, 4095, -1, 4096n, NaN, 4096.5, 2 ** 32 + 4096]) {
        Object.assign(exports, {
          __wasm_fork_clone3_features: feature === undefined ? undefined : () => feature,
        });
        assert.equal(enter(), -95);
        assert.equal(calls.descriptors, 0);
      }
      Object.assign(exports, { __wasm_fork_clone3_features: () => 4096 });
      assert.equal(enter(), 0);
      controller.suspend();
      assert.equal(controller.clone(), p(-11));
      controller.resumeParent(p(-11));
      assert.equal(enter(), -11);
      assert.equal(forwarded, 1);
      Object.assign(exports, {
        __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
          assert.deepEqual(args, [0n, p(0), p(0), p(0)]);
          return p(-9);
        },
      });
      view.setBigUint64(8192, 0n, true);
      assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
      controller.suspend();
      assert.equal(controller.clone(), p(-9));
      controller.resumeParent(p(-9));
      assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -9);
    });

for (const address of ["i32", "i64"] as const)
  for (const native of [true, false])
    for (const sharing of [0x600, 0x40000, 0x40600, 0x80000000, 0x80040600])
      test(`${address}: ${native ? "clone3" : "clone"} resource sharing ${sharing} is explicit and never lost on fallback`, () => {
        const {
          controller,
          exports,
          memory,
          pointer: p,
          calls,
        } = fixture(address, true, 2, true, undefined, true);
        const view = new DataView(memory.buffer);
        view.setBigUint64(8192, BigInt(sharing), true);
        view.setBigUint64(8224, 17n, true);
        let forwarded = 0;
        Object.assign(exports, {
          __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
            assert.ok(native);
            assert.deepEqual(args, [BigInt(sharing), p(0), p(0), p(0)]);
            forwarded++;
            return p(-11);
          },
          __wasm_fork_clone_options: (...args: WasmAddress[]) => {
            assert.ok(!native);
            assert.deepEqual(args, [p(sharing), p(0), p(0)]);
            forwarded++;
            return p(-11);
          },
        });
        const enter = () =>
          native
            ? controller.clone3Checkpoint(p(8192), p(88), true)
            : controller.cloneCheckpoint([p(sharing | 17), p(0), p(-1), p(-1), p(-1), p(-1)], true);
        for (const feature of [
          undefined,
          0,
          7,
          8n,
          NaN,
          8.5,
          ...(sharing & 0x40000 ? [8, 15] : []),
          ...(sharing & 0x80000000 ? [2047, -1] : []),
        ]) {
          Object.assign(exports, {
            __wasm_fork_clone3_features: feature === undefined ? undefined : () => feature,
          });
          assert.equal(enter(), -95);
          assert.equal(calls.descriptors, 0);
        }
        Object.assign(exports, {
          __wasm_fork_clone3_features: () =>
            sharing === 0x40000 ? 16 : sharing === 0x80000000 ? 2048 : 4095,
        });
        assert.equal(enter(), 0);
        controller.suspend();
        assert.equal(controller.clone(), p(-11));
        controller.resumeParent(p(-11));
        assert.equal(enter(), -11);
        assert.equal(forwarded, 1);
        Object.assign(exports, {
          __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
            assert.deepEqual(args, [0n, p(0), p(0), p(0)]);
            return p(-9);
          },
        });
        view.setBigUint64(8192, 0n, true);
        assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
        controller.suspend();
        assert.equal(controller.clone(), p(-9));
        controller.resumeParent(p(-9));
        assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -9);
      });

for (const address of ["i32", "i64"] as const)
  test(`${address}: clone3 PID selection requires capture support and clears after kernel refusal`, () => {
    const {
      controller,
      exports,
      memory,
      pointer: p,
      calls,
    } = fixture(address, true, 2, true, undefined, true);
    const view = new DataView(memory.buffer);
    view.setBigUint64(8224, 17n, true);
    view.setBigUint64(8256, 9001n, true);
    view.setBigUint64(8264, 2n, true);
    view.setInt32(9001, 60001, true);
    view.setInt32(9005, -19, true);
    const staged: WasmAddress[][] = [];
    Object.assign(exports, {
      __wasm_fork_clone3_set_tid: (...args: WasmAddress[]) => {
        staged.push(args);
        return 0;
      },
      __wasm_fork_clone3_pid_select: (...args: WasmAddress[]) => {
        assert.deepEqual(args, [0n, p(0), p(0), p(0), 0n, 2]);
        return p(-17);
      },
      __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
        assert.deepEqual(args, [0n, p(0), p(0), p(0)]);
        return p(-11);
      },
    });
    for (const feature of [undefined, 0, 3, 4n, NaN, 4.5]) {
      Object.assign(exports, {
        __wasm_fork_clone3_features: feature === undefined ? undefined : () => feature,
      });
      assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), -95);
      assert.equal(calls.descriptors, 0);
    }
    Object.assign(exports, { __wasm_fork_clone3_features: () => 7 });
    for (const name of ["__wasm_fork_clone3_set_tid", "__wasm_fork_clone3_pid_select"]) {
      const helper = Reflect.get(exports, name);
      Object.assign(exports, { [name]: undefined });
      assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), -95);
      assert.equal(calls.descriptors, 0);
      Object.assign(exports, { [name]: helper });
    }
    const oldKernel = new ForkContinuation(
      { exports } as unknown as WebAssembly.Instance,
      memory,
      address,
      undefined,
      true,
      false,
    );
    assert.equal(oldKernel.clone3Checkpoint(p(8192), p(88), true), -95);
    assert.equal(calls.descriptors, 0);
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
    view.setInt32(9001, 99, true);
    controller.suspend();
    assert.equal(controller.clone(), p(-17));
    assert.deepEqual(staged, [
      [0, 60001],
      [1, -19],
    ]);
    controller.resumeParent(p(-17));
    assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -17);
    view.setBigUint64(8256, 0n, true);
    view.setBigUint64(8264, 0n, true);
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
    controller.suspend();
    assert.equal(controller.clone(), p(-11));
    controller.resumeParent(p(-11));
    assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -11);
    assert.equal(staged.length, 2);
  });

for (const address of ["i32", "i64"] as const)
  test(`${address}: clone3 cgroup capability, captured fd and failure cleanup`, () => {
    const {
      controller,
      exports,
      memory,
      pointer: p,
      calls,
    } = fixture(address, true, 2, true, undefined, true);
    const view = new DataView(memory.buffer);
    view.setBigUint64(8192, 0x200000000n, true);
    view.setBigUint64(8224, 17n, true);
    view.setBigUint64(8272, 19n, true);
    let groupCalls = 0,
      plainCalls = 0;
    Object.assign(exports, {
      __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
        plainCalls++;
        assert.deepEqual(args, [0n, p(0), p(0), p(0)]);
        return p(-11);
      },
      __wasm_fork_clone3_cgroup: (...args: WasmAddress[]) => {
        groupCalls++;
        assert.deepEqual(args, [0x200000000n, p(0), p(0), p(0), 19n]);
        return p(-9);
      },
    });
    for (const features of [undefined, 0, 1, 2n, NaN, 2.5]) {
      Object.assign(exports, {
        __wasm_fork_clone3_features: features === undefined ? undefined : () => features,
      });
      assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), -95);
      assert.equal(calls.descriptors, 0);
    }
    Object.assign(exports, { __wasm_fork_clone3_features: () => 3 });
    const helper = Reflect.get(exports, "__wasm_fork_clone3_cgroup");
    Object.assign(exports, { __wasm_fork_clone3_cgroup: undefined });
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), -95);
    assert.equal(calls.descriptors, 0);
    Object.assign(exports, { __wasm_fork_clone3_cgroup: helper });
    const oldKernel = new ForkContinuation(
      { exports } as unknown as WebAssembly.Instance,
      memory,
      address,
      undefined,
      true,
      false,
    );
    assert.equal(oldKernel.clone3Checkpoint(p(8192), p(88), true), -95);
    assert.equal(calls.descriptors, 0);
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
    view.setBigUint64(8272, 77n, true);
    controller.suspend();
    assert.equal(controller.clone(), p(-9));
    controller.resumeParent(p(-9));
    assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -9);
    view.setBigUint64(8192, 0n, true);
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
    controller.suspend();
    assert.equal(controller.clone(), p(-11));
    controller.resumeParent(p(-11));
    assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -11);
    assert.equal(groupCalls, 1);
    assert.equal(plainCalls, 1);
  });

for (const address of ["i32", "i64"] as const)
  for (const native of [true, false])
    test(`${address}: ${native ? "clone3" : "clone"} CLONE_PARENT requires transport and clears after failure`, () => {
      const {
        controller: c,
        exports,
        memory,
        pointer: p,
        calls,
      } = fixture(address, true, 2, true, undefined, true);
      const view = new DataView(memory.buffer);
      view.setBigUint64(8192, 0x8000n, true);
      view.setBigUint64(8224, native ? 0n : 17n, true);
      let expected = 0x8000;
      Object.assign(exports, {
        __wasm_fork_clone3_exit_signal: (signal: number) => {
          assert.equal(signal, expected ? 0 : 17);
          return 0;
        },
        __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
          assert.ok(native);
          assert.deepEqual(args, [BigInt(expected), p(0), p(0), p(0)]);
          return p(-11);
        },
        __wasm_fork_clone_options: (...args: WasmAddress[]) => {
          assert.ok(!native);
          assert.deepEqual(args, [p(expected), p(0), p(0)]);
          return p(-11);
        },
      });
      const enter = () =>
        native
          ? c.clone3Checkpoint(p(8192), p(88), true)
          : c.cloneCheckpoint([p(expected | 17), p(0), p(0), p(0), p(0), p(0)], true);
      for (const features of [0, 511, -1, 1024, ...(native ? [512] : [])]) {
        Object.assign(exports, { __wasm_fork_clone3_features: () => features });
        assert.equal(enter(), -95);
        assert.equal(calls.descriptors, 0);
      }
      Object.assign(exports, { __wasm_fork_clone3_features: () => (native ? 576 : 512) });
      for (const flags of [0x8000, 0]) {
        expected = flags;
        view.setBigUint64(8192, BigInt(flags), true);
        view.setBigUint64(8224, flags && native ? 0n : 17n, true);
        assert.equal(enter(), 0);
        c.suspend();
        assert.equal(c.clone(), p(-11));
        c.resumeParent(p(-11));
        assert.equal(enter(), -11);
      }
    });

for (const address of ["i32", "i64"] as const)
  test(`${address}: PIDFD lifetime flags require every capability and clear after refusal`, () => {
    const {
      controller: c,
      exports,
      memory,
      pointer: p,
      calls,
    } = fixture(address, true, 2, true, undefined, true);
    const view = new DataView(memory.buffer);
    view.setBigUint64(8192, 0x1c00001000n, true);
    view.setBigUint64(8200, 9000n, true);
    view.setBigUint64(8224, 0n, true);
    let expectedFlags = 0x1c00000000n,
      expectedSignal = 0;
    Object.assign(exports, {
      __wasm_fork_clone3_exit_signal: (signal: number) => {
        assert.equal(signal, expectedSignal);
        return 0;
      },
      __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
        assert.deepEqual(args, [expectedFlags, expectedFlags ? p(9000) : p(0), p(0), p(0)]);
        return p(-22);
      },
    });
    for (const features of [0, -1, 2 ** 40 + 511, 511.5, 127, 255, 383, 447, 479]) {
      Object.assign(exports, { __wasm_fork_clone3_features: () => features });
      assert.equal(c.clone3Checkpoint(p(8192), p(88), true), -95);
      assert.equal(calls.descriptors, 0);
    }
    Object.assign(exports, { __wasm_fork_clone3_features: () => 511 });
    for (const flags of [0x1c00001000n, 0n]) {
      expectedFlags = flags & ~0x1000n;
      expectedSignal = flags ? 0 : 17;
      view.setBigUint64(8192, flags, true);
      view.setBigUint64(8224, BigInt(expectedSignal), true);
      assert.equal(c.clone3Checkpoint(p(8192), p(88), true), 0);
      c.suspend();
      assert.equal(c.clone(), p(-22));
      c.resumeParent(p(-22));
      assert.equal(c.clone3Checkpoint(p(0), p(0), true), -22);
    }
  });

for (const address of ["i32", "i64"] as const)
  test(`${address}: nondefault clone3 exit signals need explicit transport and reset after failure`, () => {
    const {
      controller: c,
      exports,
      memory,
      pointer: p,
      calls,
    } = fixture(address, true, 2, true, undefined, true);
    const view = new DataView(memory.buffer);
    view.setBigUint64(8224, 0n, true);
    const staged: number[] = [];
    Object.assign(exports, {
      __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
        assert.deepEqual(args, [0n, p(0), p(0), p(0)]);
        return p(-11);
      },
    });
    for (const feature of [undefined, 0, 63, 64n, NaN]) {
      Object.assign(exports, {
        __wasm_fork_clone3_features: feature === undefined ? undefined : () => feature,
      });
      assert.equal(c.clone3Checkpoint(p(8192), p(88), true), -95);
    }
    Object.assign(exports, { __wasm_fork_clone3_features: () => 64 });
    assert.equal(
      c.clone3Checkpoint(p(8192), p(88), true),
      -95,
      "capability without setter is incomplete",
    );
    assert.equal(calls.descriptors, 0);
    Object.assign(exports, {
      __wasm_fork_clone3_exit_signal: (signal: number) => {
        staged.push(signal);
        return 0;
      },
    });
    const oldKernel = new ForkContinuation(
      { exports } as unknown as WebAssembly.Instance,
      memory,
      address,
      undefined,
      true,
      false,
    );
    assert.equal(oldKernel.clone3Checkpoint(p(8192), p(88), true), -95);
    for (const signal of [0, 10, 17]) {
      view.setBigUint64(8224, BigInt(signal), true);
      assert.equal(c.clone3Checkpoint(p(8192), p(88), true), 0);
      c.suspend();
      assert.equal(c.clone(), p(-11));
      assert.equal(staged.at(-1), signal);
      c.resumeParent(p(-11));
      assert.equal(c.clone3Checkpoint(p(0), p(0), true), -11);
    }
    assert.deepEqual(staged, [0, 10, 17]);
  });

for (const address of ["i32", "i64"] as const)
  test(`${address}: clone3 high flags require wide transport and clear after failure`, () => {
    const {
      controller,
      exports,
      memory,
      pointer: p,
      calls,
    } = fixture(address, true, 2, true, undefined, true);
    const view = new DataView(memory.buffer);
    view.setBigUint64(8192, 0x100000000n, true);
    view.setBigUint64(8224, 17n, true);
    Object.assign(exports, {
      __wasm_fork_clone3_native: () => {
        throw new Error("high flags narrowed to an old helper");
      },
    });
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), -95);
    assert.equal(calls.descriptors, 0);
    let expected = 0x100000000n;
    Object.assign(exports, {
      __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
        assert.deepEqual(args, [expected, p(0), p(0), p(0)]);
        return dispatch_fork_syscall(controller, p(435), [], true, () => p(-11));
      },
    });
    const oldKernel = new ForkContinuation(
      { exports } as unknown as WebAssembly.Instance,
      memory,
      address,
      undefined,
      true,
      false,
    );
    assert.equal(oldKernel.clone3Checkpoint(p(8192), p(88), true), -95);
    for (const flags of [0x100000000n, 0n]) {
      expected = flags;
      view.setBigUint64(8192, flags, true);
      assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
      controller.suspend();
      assert.equal(controller.clone(), p(-11));
      controller.resumeParent(p(-11));
      assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -11);
    }
  });

for (const address of ["i32", "i64"] as const)
  for (const [flag, capability] of [
    [0x80n, 1],
    [0x800000000n, 32],
    [0x2000000000n, 1024],
  ] as const)
    test(`${address}: native flag ${flag} needs an explicit object capability`, () => {
      const {
        controller,
        exports,
        memory,
        pointer: p,
        calls,
      } = fixture(address, true, 2, true, undefined, true);
      const view = new DataView(memory.buffer);
      view.setBigUint64(8192, 0x100000000n | flag, true);
      view.setBigUint64(8224, 17n, true);
      let expected = 0x100000000n | flag;
      Object.assign(exports, {
        __wasm_fork_clone3_flags64: (...args: WasmAddress[]) => {
          assert.deepEqual(args, [expected, p(0), p(0), p(0)]);
          return dispatch_fork_syscall(controller, p(435), [], true, () => p(-11));
        },
        __wasm_fork_clone_options: () => {
          throw new Error("native-only flag used legacy clone");
        },
      });
      for (const features of [
        undefined,
        0,
        2,
        1n,
        NaN,
        1.5,
        ...(capability === 32 ? [1, 15, 31] : []),
        ...(capability === 1024 ? [1023, -1, 1024n] : []),
      ]) {
        Object.assign(exports, {
          __wasm_fork_clone3_features: features === undefined ? undefined : () => features,
        });
        assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), -95);
        assert.equal(calls.descriptors, 0, "old or malformed capability refuses before unwind");
      }
      Object.assign(exports, { __wasm_fork_clone3_features: () => capability });
      const oldKernel = new ForkContinuation(
        { exports } as unknown as WebAssembly.Instance,
        memory,
        address,
        undefined,
        true,
        false,
      );
      assert.equal(oldKernel.clone3Checkpoint(p(8192), p(88), true), -95);
      assert.equal(calls.descriptors, 0);
      for (const flags of [0x100000000n | flag, flag, 0n]) {
        expected = flags;
        view.setBigUint64(8192, flags, true);
        assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
        controller.suspend();
        assert.equal(controller.clone(), p(-11));
        controller.resumeParent(p(-11));
        assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -11);
      }
      assert.equal(controller.cloneCheckpoint([p(0x91), p(0), p(0), p(0), p(0), p(0)], true), -95);
    });

for (const address of ["i32", "i64"] as const)
  test(`${address}: legacy TID clone retains syscall 220 even with native clone3 available`, () => {
    const { controller, exports, pointer: p } = fixture(address, true, 2, true, undefined, true);
    const args = [0x01300011, 0, 9008, 9016, -1, 999].map(p);
    Object.assign(exports, {
      __wasm_fork_clone3_native: () => {
        throw new Error("legacy clone changed syscall number");
      },
    });
    assert.equal(
      controller.cloneCheckpoint(args, true),
      -95,
      "native clone3 must not substitute for missing legacy TID transport",
    );
    let invoked = false;
    Object.assign(exports, {
      __wasm_fork_clone_options: (...options: WasmAddress[]) => {
        assert.deepEqual(options, [p(0x01300000), p(9008), p(9016)]);
        return dispatch_fork_syscall(
          controller,
          p(220),
          [p(7), p(0), ...options, p(0)],
          true,
          () => {
            invoked = true;
            assert.equal(controller.nativeClone3EntryAllowed(), false);
            return p(1234);
          },
        );
      },
    });
    assert.equal(controller.cloneCheckpoint(args, true), 0);
    controller.suspend();
    assert.equal(controller.clone(), p(1234));
    assert.equal(invoked, true);
    controller.resumeParent(p(1234));
    assert.equal(controller.cloneCheckpoint(args, true), 1234);
  });

for (const address of ["i32", "i64"] as const)
  test(`${address}: native clone3 preserves distinct TIDs and scopes kernel dispatch`, () => {
    const {
      controller,
      exports,
      memory,
      pointer: p,
    } = fixture(address, true, 2, true, undefined, true);
    const view = new DataView(memory.buffer);
    view.setBigUint64(8192, 0x01301000n, true);
    view.setBigUint64(8200, 9000n, true); // PIDFD
    view.setBigUint64(8208, 9016n, true); // child_tid
    view.setBigUint64(8216, 9008n, true); // parent_tid
    view.setBigUint64(8224, 17n, true);
    assert.equal(
      controller.clone3Checkpoint(p(8192), p(88), true),
      -95,
      "a kernel capability alone cannot replace the execution helper",
    );
    let calls = 0;
    Object.assign(exports, {
      __wasm_fork_clone3_native: (...args: WasmAddress[]) => {
        calls++;
        assert.deepEqual(args, [p(0x01300000), p(9000), p(9008), p(9016)]);
        assert.equal(controller.nativeClone3DispatchAllowed(), true);
        return dispatch_fork_syscall(controller, p(435), [], true, () => {
          assert.equal(controller.nativeClone3DispatchAllowed(), false);
          assert.equal(controller.nativeClone3EntryAllowed(), true);
          assert.equal(
            dispatch_fork_syscall(controller, p(435), [], true, () => {
              throw new Error("nested native clone3 reached kernel");
            }),
            p(-38),
          );
          return p(-11);
        });
      },
    });
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
    controller.suspend();
    assert.equal(controller.clone(), p(-11));
    assert.equal(calls, 1);
    assert.equal(controller.nativeClone3DispatchAllowed(), false);
    const oldKernel = new ForkContinuation(
      { exports } as unknown as WebAssembly.Instance,
      memory,
      address,
      undefined,
      true,
      false,
    );
    assert.equal(
      oldKernel.clone3Checkpoint(p(8192), p(88), true),
      -95,
      "an execution helper cannot enable TID flags on an older kernel",
    );
    controller.resumeParent(p(-11));
    assert.equal(controller.clone3Checkpoint(p(0), p(0), true), -11);
    assert.equal(
      dispatch_fork_syscall(controller, p(435), [], true, () => {
        throw new Error("idle native clone3 reached kernel");
      }),
      p(-38),
    );

    Object.assign(exports, {
      __wasm_fork_clone3_native: () => {
        throw new Error("clone trap");
      },
    });
    assert.equal(controller.clone3Checkpoint(p(8192), p(88), true), 0);
    controller.suspend();
    assert.throws(() => controller.clone(), /clone trap/);
    assert.equal(controller.nativeClone3DispatchAllowed(), false);
  });

test("syscall import versions are explicit; an unknown version is not admitted", () => {
  const string = (value: string) => [value.length, ...new TextEncoder().encode(value)];
  for (const name of ["syscall", "syscall_v2", "syscall_v3"]) {
    const imports = [1, ...string("linux"), ...string(name), 0, 0];
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
        1,
        4,
        1,
        0x60,
        0,
        0,
        2,
        imports.length,
        ...imports,
      ]),
    );
    assert.equal(user_module_imports_supported(module), name !== "syscall_v3");
    assert.equal(uses_fork_continuation(module), false, "v2 alone does not promise fork support");
  }
});

for (const address of ["i32", "i64"] as const) {
  test(`${address}: strict policy enters the kernel before any fork adapter work`, () => {
    const f = fixture(address, true);
    const p = f.pointer;
    const trap = new Error("kernel policy killed task");
    let entered = 0;
    const invoke = () => {
      entered++;
      throw trap;
    };
    for (const controller of [f.controller, null]) {
      for (const layout of ["callback-v1", "flags-v2"] as const) {
        for (const nr of [220, 435, 172]) {
          assert.throws(
            () => dispatch_fork_syscall(controller, p(nr), [], false, invoke, layout, true),
            (error) => error === trap,
          );
          assert.equal(f.exports.asyncify_get_state(), 0);
        }
      }
      assert.throws(
        () => dispatch_fork_checkpoint(controller, p(0), false, invoke, true),
        (error) => error === trap,
      );
      assert.equal(
        dispatch_fork_checkpoint(controller, p(0), false, () => p(-38), true),
        -38,
      );
      assert.equal(
        dispatch_fork_syscall(controller, p(435), [], false, () => p(-17), "flags-v2", true),
        p(-17),
      );
    }
    assert.equal(entered, 14);
    // The guard must be left balanced even when the real entry never returns.
    assert.equal(f.controller.syscallCheckpoint(true), 0);
  });
  test(`${address}: raw high stack and TLS registers survive parent and child restore`, () => {
    const registers = {
      stack: address === "i32" ? 0x80000040 : 0x100000040,
      tls: address === "i32" ? 0x80001000 : 0x100001000,
    };
    const parent = fixture(address, true, 2, true, registers);
    const child = fixture(address, true, 2, true, registers);
    assert.equal(parent.controller.syscallCheckpoint(true), 0);
    const snapshot = parent.controller.suspend();
    assert.equal(snapshot.stack, parent.exports.__stack_pointer.value);
    assert.equal(snapshot.tls, parent.exports.__tls_base.value);
    if (address === "i32") assert.ok(Number(snapshot.stack) < 0 && Number(snapshot.tls) < 0);
    child.exports.__stack_pointer.value = child.pointer(4096);
    child.exports.__tls_base.value = child.pointer(2048);
    child.controller.resumeChild(snapshot);
    assert.equal(child.exports.__stack_pointer.value, snapshot.stack);
    assert.equal(child.exports.__tls_base.value, snapshot.tls);
    assert.equal(child.controller.syscallCheckpoint(true), 0);
    parent.controller.resumeParent(parent.pointer(123));
    assert.equal(parent.controller.syscallCheckpoint(true), 123);
  });

  test(`${address}: syscall ABI 1 stays compatible, ABI 2 enables clone3, unknown versions refuse`, () => {
    const old = fixture(address, true, 1),
      p = old.pointer;
    assert.equal(
      dispatch_fork_syscall(
        old.controller,
        p(435),
        [p(0), p(0), p(0), p(0), p(0), p(0)],
        true,
        () => {
          assert.fail("kernel clone3");
        },
        "flags-v2",
      ),
      p(-38),
    );
    assert.equal(old.calls.descriptors, 0);
    assert.equal(
      dispatch_fork_syscall(
        old.controller,
        p(220),
        [p(17), p(0), p(0), p(0), p(0), p(0)],
        true,
        () => {
          assert.fail("callback fallback");
        },
        "flags-v2",
      ),
      p(0),
    );
    assert.equal(old.calls.descriptors, 1);
    assert.throws(() => fixture(address, true, 3), /unsupported syscall ABI version/);
    const current = fixture(address, true, 2);
    assert.equal(
      dispatch_fork_syscall(
        current.controller,
        p(435),
        [p(0), p(88), p(0), p(0), p(0), p(0)],
        false,
        () => p(0),
        "flags-v2",
      ),
      p(-95),
    );
    assert.equal(current.calls.descriptors, 0);
  });

  test(`${address}: clone3 resumes the admitted parent/child request without rereading arguments`, () => {
    const f = fixture(address, true, 2),
      p = f.pointer;
    const view = new DataView(f.memory.buffer);
    view.setBigUint64(4096 + 32, 17n, true);
    let kernel = 0;
    const invoke = () => {
      kernel++;
      return p(999);
    };
    const dispatch = (layout: "flags-v2" | "callback-v1", pointer = 4096, size = 88) =>
      dispatch_fork_syscall(
        f.controller,
        p(435),
        [p(pointer), p(size), p(777), p(0), p(0), p(0)],
        true,
        invoke,
        layout,
      );
    assert.equal(dispatch("callback-v1"), p(-38));
    assert.equal(
      dispatch_fork_syscall(
        null,
        p(435),
        [p(4096), p(88), p(0), p(0), p(0), p(0)],
        true,
        invoke,
        "flags-v2",
      ),
      p(-95),
    );
    assert.equal(
      f.controller.kernelCall(() => dispatch("flags-v2")),
      p(-95),
    );
    assert.equal(dispatch("flags-v2", 4096, 63), p(-22));
    assert.equal(f.calls.descriptors, 0);
    assert.equal(dispatch("flags-v2"), p(0));
    assert.equal(dispatch("flags-v2"), p(-16));
    const snapshot = f.controller.suspend();
    const child = fixture(address, true, 2);
    new Uint8Array(child.memory.buffer).set(new Uint8Array(f.memory.buffer));
    child.controller.resumeChild(snapshot);
    // The arguments can alias saved-frame storage. Rewind must complete the
    // old request even if the current memory/pointer no longer parses.
    assert.equal(
      dispatch_fork_syscall(
        child.controller,
        p(435),
        [p(0), p(0), p(0), p(0), p(0), p(0)],
        true,
        invoke,
        "flags-v2",
      ),
      p(0),
    );
    f.controller.resumeParent(p(-11));
    assert.equal(dispatch("flags-v2", 0, 0), p(-11));
    assert.equal(f.calls.descriptors, 1);
    assert.equal(dispatch("flags-v2"), p(0));
    f.controller.suspend();
    f.controller.resumeParent(p(123));
    assert.equal(dispatch("flags-v2", 0, 0), p(123));
    assert.equal(f.calls.descriptors, 2);
    assert.equal(kernel, 0, "clone3 must never reach callback-based kernel clone directly");
  });

  test(`${address}: clone3 PIDFD captures its output pointer and clears options after every clone`, () => {
    const oldKernel = fixture(address, true, 2, false),
      oldView = new DataView(oldKernel.memory.buffer);
    oldView.setBigUint64(4096, 0x1000n, true);
    oldView.setBigUint64(4104, 8193n, true);
    oldView.setBigUint64(4128, 17n, true);
    Object.assign(oldKernel.exports, {
      __wasm_fork_clone_pidfd: () => assert.fail("old kernel clone"),
    });
    assert.equal(
      oldKernel.controller.clone3Checkpoint(oldKernel.pointer(4096), oldKernel.pointer(64), true),
      -95,
    );
    assert.equal(oldKernel.calls.descriptors, 0);
    for (const outcome of [1234, -11, "trap"] as const) {
      const f = fixture(address, true, 2),
        p = f.pointer;
      const view = new DataView(f.memory.buffer);
      view.setBigUint64(4096, 0x1000n, true);
      view.setBigUint64(4104, 8193n, true);
      view.setBigUint64(4128, 17n, true);
      assert.equal(
        f.controller.clone3Checkpoint(p(4096), p(64), true),
        -95,
        "older execution objects do not silently discard PIDFD",
      );
      assert.equal(f.calls.descriptors, 0);
      const passed: WasmAddress[] = [];
      Object.assign(f.exports, {
        __wasm_fork_clone_pidfd: (pointer: WasmAddress) => {
          passed.push(pointer);
          if (outcome === "trap") throw Error("clone trap");
          return p(outcome);
        },
      });
      assert.equal(
        f.controller.kernelCall(() => f.controller.clone3Checkpoint(p(4096), p(64), true)),
        -95,
      );
      assert.equal(f.controller.clone3Checkpoint(p(4096), p(64), false), -95);
      assert.equal(f.calls.descriptors, 0);
      assert.equal(f.controller.clone3Checkpoint(p(4096), p(64), true), 0);
      assert.equal(f.controller.clone3Checkpoint(p(0), p(0), true), -16);
      // Only the admitted, copied arguments may select the kernel operation.
      view.setBigUint64(4104, 1n << 55n, true);
      f.controller.suspend();
      if (outcome === "trap") assert.throws(() => f.controller.clone(), /clone trap/);
      else assert.equal(f.controller.clone(), p(outcome));
      assert.deepEqual(passed, [p(8193)]);
      // A fresh child rewinds the original request without a PIDFD helper or
      // valid argument memory, and never allocates another descriptor.
      const child = fixture(address, true, 2);
      // The saved descriptor remains valid in this fixture's default memory.
      child.controller.resumeChild({
        version: 1,
        address,
        descriptor: p(64),
        stack: p(32768),
        tls: p(1024),
        entry: p(7),
      });
      assert.equal(child.controller.clone3Checkpoint(p(0), p(0), true), 0);
      f.controller.resumeParent(p(outcome === "trap" ? -11 : outcome));
      assert.equal(
        f.controller.clone3Checkpoint(p(0), p(0), true),
        outcome === "trap" ? -11 : outcome,
      );
      assert.equal(f.controller.syscallCheckpoint(true), 0);
      f.controller.suspend();
      assert.equal(f.controller.clone(), p(1234), "later plain fork uses its original helper");
      assert.deepEqual(passed, [p(8193)]);
    }
  });

  test(`${address}: clone3 namespace transport preserves admitted flags and rollback`, () => {
    for (const withPidfd of [false, true])
      for (const outcome of [321, -1, -11, "trap"] as const) {
        const f = fixture(address, true, 2),
          p = f.pointer;
        const view = new DataView(f.memory.buffer);
        view.setBigUint64(4096, 0x0c020000n | (withPidfd ? 0x1000n : 0n), true);
        view.setBigUint64(4104, withPidfd ? 8193n : 0n, true);
        view.setBigUint64(4128, 17n, true);
        assert.equal(f.controller.clone3Checkpoint(p(4096), p(88), true), -95);
        assert.equal(f.calls.descriptors, 0, "old execution support cannot drop namespace flags");
        const passed: WasmAddress[][] = [];
        Object.assign(f.exports, {
          __wasm_fork_clone_namespaces: (...args: WasmAddress[]) => {
            passed.push(args);
            if (outcome === "trap") throw Error("namespace clone trap");
            return p(outcome);
          },
        });
        assert.equal(f.controller.clone3Checkpoint(p(4096), p(88), false), -95);
        assert.equal(
          f.controller.kernelCall(() => f.controller.clone3Checkpoint(p(4096), p(88), true)),
          -95,
        );
        assert.equal(f.controller.clone3Checkpoint(p(4096), p(88), true), 0);
        // Namespace creation must use the bounded request already copied,
        // not argument memory modified while the continuation unwinds.
        view.setBigUint64(4096, 0x100n, true);
        view.setBigUint64(4104, 1n << 55n, true);
        f.controller.suspend();
        if (outcome === "trap") assert.throws(() => f.controller.clone(), /namespace clone trap/);
        else assert.equal(f.controller.clone(), p(outcome));
        assert.deepEqual(passed, [[p(0x0c020000), p(withPidfd ? 8193 : 0)]]);
        f.controller.resumeParent(p(outcome === "trap" ? -11 : outcome));
        assert.equal(
          f.controller.clone3Checkpoint(p(0), p(0), true),
          outcome === "trap" ? -11 : outcome,
        );
        assert.equal(f.controller.syscallCheckpoint(true), 0);
        f.controller.suspend();
        assert.equal(
          f.controller.clone(),
          p(1234),
          "plain fork has no stale namespace/pidfd options",
        );
        assert.equal(passed.length, 1);
      }
    const oldKernel = fixture(address, true, 2, false),
      p = oldKernel.pointer;
    const view = new DataView(oldKernel.memory.buffer);
    view.setBigUint64(4096, 0x04001000n, true);
    view.setBigUint64(4104, 8193n, true);
    view.setBigUint64(4128, 17n, true);
    Object.assign(oldKernel.exports, {
      __wasm_fork_clone_namespaces: () => assert.fail("old pidfd kernel"),
    });
    assert.equal(oldKernel.controller.clone3Checkpoint(p(4096), p(88), true), -95);
    assert.equal(oldKernel.calls.descriptors, 0);
  });

  test(`${address}: child injection precedes rewind and stack/TLS restore at the deferred user boundary`, () => {
    const parent = fixture(address, true),
      child = fixture(address, true),
      p = parent.pointer;
    parent.controller.syscallCheckpoint(true);
    const snapshot = parent.controller.suspend();
    const owner: { fork_continuation?: ForkSnapshot } = { fork_continuation: snapshot };
    child.exports.__stack_pointer.value = p(8192);
    child.exports.__tls_base.value = p(4096);
    let called = false;
    const deferred = () =>
      resume_fork_child(owner, child.controller, () => {
        called = true;
        assert.equal(child.exports.asyncify_get_state(), 0);
        assert.equal(child.exports.__stack_pointer.value, p(8192));
        assert.equal(child.exports.__tls_base.value, p(4096));
        assert.equal(owner.fork_continuation, snapshot);
        child.controller.kernelCall(() =>
          assert.equal(child.controller.syscallCheckpoint(true), -95),
        );
      });
    assert.equal(called, false, "startup registration must not inject");
    deferred();
    assert.equal(called, true);
    assert.equal(child.exports.asyncify_get_state(), 2);
    assert.equal(child.exports.__stack_pointer.value, snapshot.stack);
    assert.equal(child.exports.__tls_base.value, snapshot.tls);
    assert.equal("fork_continuation" in owner, false);
    assert.equal(child.controller.syscallCheckpoint(true), 0);
    assert.throws(deferred, /missing fork child snapshot/);
  });

  test(`${address}: child injection failure clears metadata and never starts rewind`, () => {
    const parent = fixture(address, true),
      child = fixture(address, true);
    parent.controller.syscallCheckpoint(true);
    const owner: { fork_continuation?: ForkSnapshot } = {
      fork_continuation: parent.controller.suspend(),
    };
    const failure = new Error("child signal syscall failed");
    assert.throws(
      () =>
        resume_fork_child(owner, child.controller, () => {
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal("fork_continuation" in owner, false);
    assert.equal(child.exports.asyncify_get_state(), 0);
    assert.throws(
      () =>
        resume_fork_child(owner, child.controller, () => assert.fail("missing snapshot injected")),
      /missing fork child snapshot/,
    );
  });

  test(`${address}: post-clone hook sees cleared metadata and stopped unwind before parent rewind`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    const owner: { fork_continuation?: ForkSnapshot } = {};
    const events: string[] = [];
    f.exports.__wasm_fork_clone = () => {
      assert.ok(owner.fork_continuation);
      events.push("clone");
      return p(1234);
    };
    f.controller.syscallCheckpoint(true);
    resume_fork_parent(
      owner,
      f.controller,
      () => events.push("saved"),
      () => {
        assert.equal(f.exports.asyncify_get_state(), 0);
        assert.equal("fork_continuation" in owner, false);
        events.push("before-resume");
      },
    );
    assert.deepEqual(events, ["saved", "clone", "before-resume"]);
    assert.equal(f.exports.asyncify_get_state(), 2);
    assert.equal(f.controller.syscallCheckpoint(true), 1234);
  });

  test(`${address}: clone failure skips post-clone hook and preserves errno and later reuse`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    const owner: { fork_continuation?: ForkSnapshot } = {};
    for (const value of [-11, -12, 1234]) {
      f.controller.syscallCheckpoint(true);
      f.exports.__wasm_fork_clone = () => p(value);
      let injected = false;
      resume_fork_parent(owner, f.controller, undefined, () => {
        injected = true;
      });
      assert.equal(injected, value > 0);
      assert.equal("fork_continuation" in owner, false);
      assert.equal(f.controller.syscallCheckpoint(true), value);
    }
  });

  test(`${address}: clone trap or post-clone hook trap cannot report successful parent rewind`, () => {
    for (const cloneTraps of [false, true]) {
      const f = fixture(address, true),
        p = f.pointer;
      const owner: { fork_continuation?: ForkSnapshot } = {};
      const failure = new Error("post-clone signal test failed");
      let called = false;
      f.exports.__wasm_fork_clone = () => {
        if (cloneTraps) throw failure;
        return p(1234);
      };
      f.controller.syscallCheckpoint(true);
      assert.throws(
        () =>
          resume_fork_parent(owner, f.controller, undefined, () => {
            called = true;
            throw failure;
          }),
        (error) => error === failure,
      );
      assert.equal(called, !cloneTraps);
      assert.equal("fork_continuation" in owner, false);
      assert.equal(f.exports.asyncify_get_state(), 0);
    }
  });

  test(`${address}: saved-fork hook runs after suspend and before clone, with scoped metadata`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    const owner: { fork_continuation?: ForkSnapshot } = {};
    const events: string[] = [];
    f.exports.__wasm_fork_clone = () => {
      events.push("clone");
      return p(1234);
    };
    f.controller.syscallCheckpoint(true);
    resume_fork_parent(owner, f.controller, () => {
      assert.equal(f.exports.asyncify_get_state(), 0);
      assert.ok(owner.fork_continuation);
      events.push("saved");
    });
    assert.deepEqual(events, ["saved", "clone"]);
    assert.equal("fork_continuation" in owner, false);
    assert.equal(f.controller.syscallCheckpoint(true), 1234);
  });

  test(`${address}: saved-fork hook failure clears metadata and does not create a child`, () => {
    const f = fixture(address, true);
    const owner: { fork_continuation?: ForkSnapshot } = {};
    const failure = new Error("injected signal setup error");
    f.exports.__wasm_fork_clone = () => {
      assert.fail("failed hook reached clone");
    };
    f.controller.syscallCheckpoint(true);
    assert.throws(
      () =>
        resume_fork_parent(owner, f.controller, () => {
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal("fork_continuation" in owner, false);
  });

  test(`${address}: copy failures rewind errno, clear clone metadata and permit a later fork`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    const owner: { fork_continuation?: ForkSnapshot } = {};
    const failed: Int32Array<SharedArrayBuffer>[] = [];
    for (const errno of [USER_COPY_TRY_AGAIN, USER_COPY_NO_MEMORY, USER_COPY_TRY_AGAIN]) {
      const status = new Int32Array(new SharedArrayBuffer(4));
      failed.push(status);
      assert.equal(f.controller.syscallCheckpoint(true), 0);
      f.exports.__wasm_fork_clone = () => {
        assert.equal(owner.fork_continuation?.descriptor, p(64));
        if (errno === USER_COPY_NO_MEMORY) settle_user_copy(status, errno);
        return p(wait_user_copy(status, 0));
      };
      resume_fork_parent(owner, f.controller);
      assert.equal("fork_continuation" in owner, false);
      assert.equal(f.controller.syscallCheckpoint(true), errno);
      assert.equal(f.controller.unwinding(), false);
      assert.equal(
        settle_user_copy(status, USER_COPY_COMPLETE),
        false,
        "late child cannot publish",
      );
    }
    const child = fixture(address, true);
    let snapshot: ForkSnapshot | undefined;
    f.exports.__wasm_fork_clone = () => {
      snapshot = owner.fork_continuation;
      return p(1234);
    };
    assert.equal(f.controller.syscallCheckpoint(true), 0);
    resume_fork_parent(owner, f.controller);
    assert.equal("fork_continuation" in owner, false);
    assert.ok(snapshot);
    child.controller.resumeChild(snapshot);
    assert.equal(f.controller.syscallCheckpoint(true), 1234);
    assert.equal(child.controller.syscallCheckpoint(true), 0);
    assert.equal(f.calls.descriptors, 4);
    assert.equal(child.calls.descriptors, 0);
    for (const status of failed) assert.ok(Atomics.load(status, 0) < 0);
  });

  test(`${address}: clone traps remove request metadata without inventing a recoverable errno`, () => {
    const f = fixture(address, true);
    const owner: { fork_continuation?: ForkSnapshot } = {};
    const failure = new Error("injected clone trap");
    f.exports.__wasm_fork_clone = () => {
      throw failure;
    };
    f.controller.syscallCheckpoint(true);
    assert.throws(
      () => resume_fork_parent(owner, f.controller),
      (error) => error === failure,
    );
    assert.equal("fork_continuation" in owner, false);
  });

  test(`${address}: flags-first clone restores parent and child using the same continuation`, () => {
    const parent = fixture(address, true),
      child = fixture(address, true),
      p = parent.pointer;
    // The sixth register is unused, just as for Linux's five-argument clone.
    const args = [17, 0, 0, 0, 0, 123].map(p);
    const invoke = () => {
      throw new Error("v2 must never enter the callback syscall with raw flags");
    };
    const dispatch = (c: ForkContinuation) =>
      dispatch_fork_syscall(c, p(220), args, true, invoke, "flags-v2");
    assert.equal(dispatch(parent.controller), p(0));
    assert.equal(dispatch(parent.controller), p(-16));
    const snapshot = parent.controller.suspend();
    parent.controller.resumeParent(p(1234));
    child.controller.resumeChild(snapshot);
    assert.equal(dispatch(parent.controller), p(1234));
    assert.equal(dispatch(child.controller), p(0));
    assert.equal(parent.calls.descriptors, 1);
    assert.equal(child.calls.descriptors, 0);
    assert.equal(dispatch(parent.controller), p(0));
    parent.controller.suspend();
    parent.controller.resumeParent(p(-12));
    assert.equal(dispatch(parent.controller), p(-12));
  });

  test(`${address}: flags-first namespace/PIDFD clone uses captured options and finishes its rewind`, () => {
    for (const outcome of [321, -1, -11, "trap"] as const) {
      const f = fixture(address, true, 2),
        p = f.pointer;
      const args = [p(17 | 0x0c021000), p(0), p(8193), p(0), p(0), p(999)];
      const dispatch = () =>
        dispatch_fork_syscall(
          f.controller,
          p(220),
          args,
          true,
          () => assert.fail("flags request reached callback fallback"),
          "flags-v2",
        );
      assert.equal(dispatch(), p(-95));
      assert.equal(f.calls.descriptors, 0);
      const passed: WasmAddress[][] = [];
      Object.assign(f.exports, {
        __wasm_fork_clone_namespaces: (...options: WasmAddress[]) => {
          passed.push(options);
          if (outcome === "trap") throw Error("raw namespace trap");
          return p(outcome);
        },
      });
      assert.equal(dispatch(), p(0));
      const snapshot = f.controller.suspend();
      if (outcome === "trap") assert.throws(() => f.controller.clone(), /raw namespace trap/);
      else assert.equal(f.controller.clone(), p(outcome));
      assert.deepEqual(passed, [[p(0x0c020000), p(8193)]]);
      const result = outcome === "trap" ? -11 : outcome;
      f.controller.resumeParent(p(result));
      args[0] = p(0x100);
      args[2] = p(0);
      assert.equal(dispatch(), p(result), "rewind finishes the request already admitted");
      if (result > 0) {
        const child = fixture(address, true, 2);
        child.controller.resumeChild(snapshot);
        assert.equal(child.controller.cloneCheckpoint(args, true), 0);
      }
      assert.equal(f.controller.syscallCheckpoint(true), 0);
      f.controller.suspend();
      assert.equal(f.controller.clone(), p(1234));
      assert.equal(passed.length, 1, "later ordinary fork has no stale options");
    }
  });

  test(`${address}: flags-first clone rejects unsupported requests without callback fallback`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    const invoke = () => {
      throw new Error("unsupported v2 request reached legacy kernel clone");
    };
    const dispatch = (args: number[], allowed = true, c: ForkContinuation | null = f.controller) =>
      dispatch_fork_syscall(c, p(220), args.map(p), allowed, invoke, "flags-v2");
    const args = [17, 0, 0, 0, 0, 0];
    assert.equal(dispatch(args, true, null), p(-95));
    assert.equal(dispatch(args, true, fixture(address).controller), p(-95));
    assert.equal(dispatch(args, false), p(-95));
    assert.equal(
      f.controller.kernelCall(() => dispatch(args)),
      p(-95),
    );
    for (const [index, value] of [
      [0, 0],
      [0, 7],
      [0, 0x100 | 17],
      [1, 8],
    ] as const) {
      const changed = [...args];
      changed[index] = value;
      assert.equal(dispatch(changed), p(-95));
    }
    assert.equal(
      dispatch([0, 0, 17, 0, 0, 0]),
      p(-95),
      "legacy null callback is not reinterpreted",
    );
    assert.equal(f.calls.descriptors, 0);
    assert.equal(
      dispatch([17, 0, -1, -1, -1, 999]),
      p(0),
      "unrequested TID/TLS registers are ignored after rejection",
    );
  });

  test(`${address}: import version, not coincident flag/table values, selects clone layout`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    let calls = 0;
    const invoke = () => {
      calls++;
      assert.equal(f.controller.syscallCheckpoint(true), -95);
      return p(83);
    };
    const args = [17, 0, 0, 0, 0, 0].map(p);
    assert.equal(
      dispatch_fork_syscall(f.controller, p(220), args, true, invoke, "callback-v1"),
      p(83),
    );
    assert.equal(calls, 1);
    assert.equal(
      dispatch_fork_syscall(f.controller, p(172), args, true, invoke, "flags-v2"),
      p(83),
    );
    assert.equal(calls, 2, "v2 non-clone syscalls still enter the guarded kernel");
    assert.equal(dispatch_fork_syscall(f.controller, p(220), args, true, invoke, "flags-v2"), p(0));
    assert.equal(calls, 2, "v2 flags are not used as a function-table index");
  });

  test(`${address}: raw clone syscall resumes parent and child without libc checkpoint`, () => {
    const parent = fixture(address, true),
      child = fixture(address, true);
    const p = parent.pointer;
    const args = [0, 0, 17, 0, 0, 0].map(p);
    const invoke = () => {
      throw new Error("null callback must not enter callback clone");
    };
    const dispatch = (c: ForkContinuation) => dispatch_fork_syscall(c, p(220), args, true, invoke);
    assert.equal(dispatch(parent.controller), p(0));
    assert.equal(parent.calls.descriptors, 1);
    assert.equal(dispatch(parent.controller), p(-16));
    const snapshot = parent.controller.suspend();
    parent.controller.resumeParent(p(1234));
    child.controller.resumeChild(snapshot);
    assert.equal(dispatch(parent.controller), p(1234));
    assert.equal(dispatch(child.controller), p(0));
    assert.equal(parent.calls.descriptors, 1);
    assert.equal(child.calls.descriptors, 0, "child rewind must not reset inherited frames");
    assert.equal(dispatch(parent.controller), p(0), "later raw clone can unwind again");
  });

  test(`${address}: raw clone rejects missing support, unsupported arguments and unsafe entries`, () => {
    const f = fixture(address, true),
      p = f.pointer;
    const invoke = () => {
      throw new Error("must not dispatch unsupported clone to kernel");
    };
    const args = [0, 0, 17, 0, 0, 0].map(p);
    for (const c of [null, fixture(address).controller])
      assert.equal(dispatch_fork_syscall(c, p(220), args, true, invoke), p(-95));
    assert.equal(dispatch_fork_syscall(f.controller, p(220), args, false, invoke), p(-95));
    assert.equal(
      f.controller.kernelCall(() =>
        dispatch_fork_syscall(f.controller, p(220), args, true, invoke),
      ),
      p(-95),
    );
    for (const [index, value, errno] of [
      [1, 9, -22],
      [2, 0, -95],
      [2, 0x100 | 17, -95],
      [3, 8, -95],
      [4, 8, -95],
      [5, 8, -95],
    ] as const) {
      const changed = [...args];
      changed[index] = p(value);
      assert.equal(dispatch_fork_syscall(f.controller, p(220), changed, true, invoke), p(errno));
    }
    assert.equal(f.calls.descriptors, 0);
    assert.equal(f.controller.unwinding(), false);
    assert.equal(dispatch_fork_syscall(f.controller, p(220), args, true, invoke), p(0));
    f.controller.suspend();
    f.controller.resumeParent(p(-12));
    assert.equal(dispatch_fork_syscall(f.controller, p(220), args, true, invoke), p(-12));
  });

  test(`${address}: ordinary syscalls and callback clone retain guarded kernel dispatch`, () => {
    const { controller: c, pointer: p } = fixture(address, true);
    const args = [7, 0, 17, 0, 0, 0].map(p);
    let calls = 0;
    const invoke = () => {
      calls++;
      assert.equal(c.syscallCheckpoint(true), -95, "kernel reentry cannot unwind");
      return p(83);
    };
    assert.equal(dispatch_fork_syscall(c, p(220), args, true, invoke), p(83));
    assert.equal(dispatch_fork_syscall(c, p(172), [0, 0, 0, 0, 0, 0].map(p), true, invoke), p(83));
    assert.equal(calls, 2);
    assert.equal(
      dispatch_fork_syscall(null, p(172), args, true, () => p(84)),
      p(84),
    );
    assert.equal(c.syscallCheckpoint(true), 0);
  });

  test(`${address}: parent resumes at checkpoint with the actual clone result`, () => {
    const { controller: c, pointer: p } = fixture(address);
    assert.equal(c.checkpoint(p(64), true), 0);
    assert.equal(c.unwinding(), true);
    const snapshot = c.suspend();
    assert.equal(snapshot.entry, p(7));
    assert.equal(c.unwinding(), false);
    assert.equal(c.clone(), p(1234));
    c.resumeParent(p(1234));
    assert.equal(c.checkpoint(p(64), true), 1234);
    assert.equal(c.checkpoint(p(64), true), 0, "a later fork can start fresh");
  });

  test(`${address}: child restores stack and TLS, then returns zero`, () => {
    const parent = fixture(address),
      child = fixture(address);
    parent.controller.checkpoint(parent.pointer(64), true);
    const snapshot = parent.controller.suspend();
    child.exports.__stack_pointer.value = child.pointer(8192);
    child.exports.__tls_base.value = child.pointer(2048);
    child.controller.resumeChild(snapshot);
    assert.equal(child.exports.__stack_pointer.value, snapshot.stack);
    assert.equal(child.exports.__tls_base.value, snapshot.tls);
    assert.equal(child.controller.checkpoint(snapshot.descriptor, true), 0);
    assert.throws(
      () => child.controller.resumeChild({ ...snapshot, version: 2 } as never),
      /ABI mismatch/,
    );
  });

  test(`${address}: clone failure resumes only the parent error path`, () => {
    const { controller: c, pointer: p } = fixture(address);
    c.checkpoint(p(64), true);
    c.suspend();
    c.resumeParent(p(-95));
    assert.equal(c.checkpoint(p(64), true), -95);
    assert.equal(c.unwinding(), false);
  });

  test(`${address}: callback and signal entry do not unwind`, () => {
    const { controller: c, pointer: p } = fixture(address);
    assert.equal(c.checkpoint(p(64), false), -95);
    assert.equal(c.unwinding(), false);
    assert.throws(() => c.suspend(), /no completed unwind/);
  });

  test(`${address}: nested kernel reentry refuses fork and restores the guard after errors`, () => {
    const { controller: c, pointer: p } = fixture(address);
    assert.equal(
      c.kernelCall(() => c.checkpoint(p(64), true)),
      -95,
    );
    assert.throws(
      () =>
        c.kernelCall(() =>
          c.kernelCall(() => {
            assert.equal(c.checkpoint(p(64), true), -95);
            throw new Error("kernel failure");
          }),
        ),
      /kernel failure/,
    );
    assert.equal(c.unwinding(), false);
    assert.equal(
      c.checkpoint(p(64), true),
      0,
      "the main entry can fork after the boundary returns",
    );
  });

  test(`${address}: malformed descriptors are refused before changing state`, () => {
    const { controller: c, pointer: p, descriptor } = fixture(address);
    for (const location of [65, 65536, -1]) assert.equal(c.checkpoint(p(location), true), -22);
    for (const [start, end] of [
      [0, 65544],
      [256, 128],
      [64, 1024],
      [129, 1024],
    ]) {
      descriptor(start, end);
      assert.equal(c.checkpoint(p(64), true), -22);
    }
    assert.equal(c.checkpoint(address === "i64" ? 64 : 64n, true), -22);
    assert.equal(c.unwinding(), false);
  });

  test(`${address}: lifecycle order and invalid parent results fail closed`, () => {
    const { controller: c, pointer: p } = fixture(address);
    assert.throws(() => c.clone(), /clone before/);
    c.checkpoint(p(64), true);
    assert.equal(c.checkpoint(p(64), true), -16);
    c.suspend();
    for (const value of [0, -4096, 0x80000000])
      assert.throws(() => c.resumeParent(p(value)), /invalid parent/);
    c.resumeParent(p(1234));
    assert.throws(() => c.checkpoint(p(128), true), /unexpected rewind/);
    assert.equal(c.checkpoint(p(64), true), 1234);
  });
}
