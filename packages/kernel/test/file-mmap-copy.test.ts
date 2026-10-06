// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { FileMmapCopy } from "../src/file-mmap-copy.ts";
import {
  user_module_imports_supported,
  type WasmMemoryDescriptor,
  type WasmAddress,
} from "../src/wasm.ts";

for (const width of ["i32", "i64"] as const) {
  const scalar = (n: number) => (width === "i64" ? BigInt(n) : n);
  const setup = () => {
    const descriptor: WasmMemoryDescriptor = {
      initial: scalar(1),
      maximum: scalar(3),
      address: width,
    };
    const kernel = new WebAssembly.Memory(descriptor as WebAssembly.MemoryDescriptor);
    const user = new WebAssembly.Memory(descriptor as WebAssembly.MemoryDescriptor);
    return { kernel, user, bridge: new FileMmapCopy(kernel, width) };
  };

  test(`${width}: real Wasm export/import crosses the scoped bridge`, () => {
    const { kernel, user, bridge } = setup();
    const name = (s: string) => [s.length, ...new TextEncoder().encode(s)];
    const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
    const value = width === "i64" ? 0x7e : 0x7f;
    const body = [0, 0x20, 0, 0x20, 1, 0x10, 0, ...(width === "i64" ? [0xac] : []), 0x0b];
    // This tiny module tests the scalar ABI only, not allocator publication.
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
        ...section(1, [2, 0x60, 2, value, value, 1, 0x7f, 0x60, 2, value, value, 1, value]),
        ...section(2, [1, ...name("linux_mmap_init_v1"), ...name("copy"), 0, 0]),
        ...section(3, [1, 1]),
        ...section(7, [1, ...name("__wasm_mmap_init_v1"), 0, 1]),
        ...section(10, [1, body.length, ...body]),
      ]),
    );
    assert.equal(user_module_imports_supported(module), true);
    const instance = new WebAssembly.Instance(module, {
      linux_mmap_init_v1: {
        copy: (to: WasmAddress, length: WasmAddress) => bridge.copy(user, to, length),
      },
    });
    new Uint8Array(kernel.buffer, 0, 3).set([1, 2, 3]);
    assert.equal(bridge.map(instance.exports, scalar(4096), scalar(0), scalar(3)), scalar(0));
    assert.deepEqual([...new Uint8Array(user.buffer, 4096, 3)], [1, 2, 3]);
    const callback = instance.exports.__wasm_mmap_init_v1 as CallableFunction;
    assert.equal(callback(scalar(4096), scalar(3)), scalar(-1));
  });

  test(`${width}: scoped copy preserves data, zero tail and old-module refusal`, () => {
    const { kernel, user, bridge } = setup();
    new Uint8Array(kernel.buffer, 17, 3).set([12, 34, 56]);
    assert.equal(bridge.copy(user, scalar(100), scalar(3)), -1);
    assert.equal(bridge.map({}, scalar(4096), scalar(17), scalar(3)), scalar(-38));
    assert.equal(
      bridge.map(
        {
          __wasm_mmap_init_v1: (size: WasmAddress, length: WasmAddress) => {
            assert.equal(size, scalar(4096));
            assert.equal(length, scalar(3));
            assert.equal(bridge.copy(user, scalar(100), length), 0);
            assert.equal(bridge.copy(user, scalar(200), length), -1);
            return scalar(100);
          },
        },
        scalar(4096),
        scalar(17),
        scalar(3),
      ),
      scalar(100),
    );
    assert.deepEqual([...new Uint8Array(user.buffer, 100, 5)], [12, 34, 56, 0, 0]);
    assert.equal(bridge.copy(user, scalar(100), scalar(3)), -1);
  });

  test(`${width}: reject invalid extents before allocator entry`, () => {
    const { bridge } = setup();
    const exports = { __wasm_mmap_init_v1: () => assert.fail("must not allocate") };
    for (const [size, source, count, errno] of [
      [0, 0, 0, 22],
      [4095, 0, 1, 22],
      [4096, 0, 4097, 22],
      [4096, 65536, 1, 14],
    ] as const) {
      assert.equal(
        bridge.map(exports, scalar(size), scalar(source), scalar(count)),
        scalar(-errno),
      );
    }
    assert.equal(
      bridge.map(exports, width === "i32" ? 4096n : 4096, scalar(0), scalar(1)),
      scalar(-22),
    );
  });

  test(`${width}: copy errors consume lease; nested calls cannot replace it`, () => {
    const { user, bridge } = setup();
    for (const [target, count, errno] of [
      [100, 2, 22],
      [65536, 3, 14],
    ] as const) {
      assert.equal(
        bridge.map(
          {
            __wasm_mmap_init_v1: () => {
              assert.equal(bridge.map({}, scalar(4096), scalar(0), scalar(3)), scalar(-16));
              assert.equal(bridge.copy(user, scalar(target), scalar(count)), -errno);
              assert.equal(bridge.copy(user, scalar(100), scalar(3)), -1);
              return scalar(-errno);
            },
          },
          scalar(4096),
          scalar(0),
          scalar(3),
        ),
        scalar(-errno),
      );
      assert.equal(bridge.copy(user, scalar(100), scalar(3)), -1);
    }
  });

  test(`${width}: traps revoke lease, and later calls can copy after both memories grow`, () => {
    const { user, kernel, bridge } = setup();
    assert.throws(
      () =>
        bridge.map(
          {
            __wasm_mmap_init_v1: () => {
              throw new WebAssembly.RuntimeError("injected trap");
            },
          },
          scalar(4096),
          scalar(0),
          scalar(3),
        ),
      /injected trap/,
    );
    assert.equal(bridge.copy(user, scalar(100), scalar(3)), -1);
    assert.equal(
      bridge.map(
        {
          __wasm_mmap_init_v1: () => {
            const grow = (memory: WebAssembly.Memory) =>
              (memory.grow as (n: number | bigint) => number | bigint)(scalar(1));
            grow(kernel);
            grow(user);
            new Uint8Array(kernel.buffer, 0, 3).set([7, 8, 9]);
            assert.equal(bridge.copy(user, scalar(65536), scalar(3)), 0);
            return scalar(65536);
          },
        },
        scalar(4096),
        scalar(0),
        scalar(3),
      ),
      scalar(65536),
    );
    assert.deepEqual([...new Uint8Array(user.buffer, 65536, 3)], [7, 8, 9]);
  });

  test(`${width}: an empty source still requires an active exact-copy lease`, () => {
    const { user, bridge } = setup();
    assert.equal(
      bridge.map(
        {
          __wasm_mmap_init_v1: () => {
            assert.equal(bridge.copy(user, scalar(65536), scalar(0)), 0);
            return scalar(4096);
          },
        },
        scalar(4096),
        scalar(65536),
        scalar(0),
      ),
      scalar(4096),
    );
  });
}

test("new user copy import is allowlisted without opening arbitrary kernel imports", () => {
  const module_for = (namespace: string, name: string) => {
    const bytes = (s: string) => [...new TextEncoder().encode(s)];
    const entry = [namespace.length, ...bytes(namespace), name.length, ...bytes(name), 0, 0];
    return new WebAssembly.Module(
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
        96,
        0,
        0,
        2,
        entry.length + 1,
        1,
        ...entry,
      ]),
    );
  };
  assert.equal(user_module_imports_supported(module_for("linux_mmap_init_v1", "copy")), true);
  assert.equal(user_module_imports_supported(module_for("linux_mmap_init_v1", "map")), false);
  assert.equal(user_module_imports_supported(module_for("user_mmap_init_v1", "map")), false);
});
