// SPDX-License-Identifier: MIT
// Host execution-contract checks, not Linux VFS acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { FileMmapCopy } from "../src/file-mmap-copy.ts";
import type { WasmAddress, WasmMemoryDescriptor } from "../src/wasm.ts";

for (const address of ["i32", "i64"] as const) {
  const p = (n: number) => (address === "i64" ? BigInt(n) : n);
  const memory = (pages: number) =>
    new WebAssembly.Memory({
      initial: p(pages),
      maximum: p(16),
      address,
    } as WasmMemoryDescriptor as WebAssembly.MemoryDescriptor);
  test(`${address}: existing initializer fills once before publishing a grown candidate`, () => {
    const user = memory(2);
    const kernel = memory(1);
    const bridge = new FileMmapCopy(kernel, address, () => ({
      abort_file_mmap_v1() {},
      populate_file_mmap_v1() {},
    }));
    let published = false,
      calls = 0;
    const exports = {
      __wasm_mmap_init_v1(size: WasmAddress, length: WasmAddress) {
        assert.equal(size, p(2 * 65536));
        assert.equal(length, size);
        user.grow(p(2) as number);
        assert.equal(bridge.copy(user, p(65536), length), 0);
        assert.equal(bridge.copy(user, p(65536), length), -1);
        published = true;
        return p(65536);
      },
    };
    assert.equal(
      bridge.map_stream(exports, p(2 * 65536), (destination, length) => {
        assert.equal(published, false);
        assert.equal(destination, p(65536));
        assert.equal(length, p(2 * 65536));
        calls++;
        assert.equal(
          bridge.map_stream(exports, length, () => 0),
          p(-16),
        );
        assert.equal(bridge.map(exports, length, p(0), p(0)), p(-16));
        new Uint8Array(user.buffer, 65536, 2 * 65536).fill(37);
        return 0;
      }),
      p(65536),
    );
    assert.equal(calls, 1);
    assert.equal(new Uint8Array(user.buffer)[65536 + 2 * 65536 - 1], 37);
    assert.equal(bridge.copy(user, p(65536), p(65536)), -1);
  });

  test(`${address}: refusals never enter a producer and exceptions revoke ownership`, () => {
    const user = memory(4),
      kernel = memory(1);
    const ke: WebAssembly.Exports = { abort_file_mmap_v1() {} };
    const bridge = new FileMmapCopy(kernel, address, () => ke);
    let copies = 0;
    const producer = () => {
      copies++;
      return 0;
    };
    const absent = {
      __wasm_mmap_init_v1() {
        assert.fail("old kernel entered initializer");
      },
    };
    assert.equal(bridge.map_stream(absent, p(65536), producer), p(-95));
    ke.populate_file_mmap_v1 = () => 0;
    for (const destination of [p(0), p(4 * 65536)]) {
      const exports = {
        __wasm_mmap_init_v1(_size: WasmAddress, length: WasmAddress) {
          return p(bridge.copy(user, destination, length));
        },
      };
      assert.equal(bridge.map_stream(exports, p(65536), producer), p(-14));
    }
    assert.equal(copies, 0);
    const reason = new Error("producer exception");
    const exports = {
      __wasm_mmap_init_v1(_size: WasmAddress, length: WasmAddress) {
        const result = bridge.copy(user, p(65536), length);
        return result ? p(result) : p(65536);
      },
    };
    let cleaned = false;
    assert.throws(
      () =>
        bridge.map_stream(
          exports,
          p(65536),
          () => {
            throw reason;
          },
          (error) => {
            assert.equal(error, reason);
            assert.equal(bridge.copy(user, p(65536), p(65536)), -1);
            cleaned = true;
          },
        ),
      (error) => error === reason,
    );
    assert.equal(cleaned, true);
    assert.throws(
      () => bridge.map_stream({ __wasm_mmap_init_v1: () => p(65536) }, p(65536), producer),
      /before successful population/,
    );
    assert.equal(bridge.map_stream(exports, p(65536), producer), p(65536));
    assert.equal(copies, 1);
  });
}
