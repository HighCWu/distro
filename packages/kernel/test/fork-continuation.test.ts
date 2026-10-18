// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  ForkContinuation,
  dispatch_fork_syscall,
  fork_continuation_exports_supported,
  uses_fork_continuation,
} from "../src/fork-continuation.ts";
import { user_module_imports_supported } from "../src/wasm.ts";
import type { WasmAddress, WasmAddressType } from "../src/wasm.ts";

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

function fixture(address: WasmAddressType, syscall = false) {
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
    __stack_pointer: global(32768),
    __tls_base: global(1024),
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
  if (syscall)
    Object.assign(exports, {
      __wasm_fork_syscall_abi: () => 1,
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
  );
  return { controller, exports, memory, pointer, descriptor, calls };
}

for (const address of ["i32", "i64"] as const) {
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
    ]) {
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
