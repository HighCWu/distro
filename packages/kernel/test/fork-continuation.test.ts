// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  ForkContinuation,
  dispatch_fork_syscall,
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

function fixture(address: WasmAddressType, syscall = false, syscallAbi = 1) {
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
  );
  return { controller, exports, memory, pointer, descriptor, calls };
}

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
      [2, 8],
      [3, 8],
      [4, 8],
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
    assert.equal(dispatch(args), p(0), "a rejected request does not poison the next clone");
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
