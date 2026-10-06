// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { user_mmap } from "../src/user-mmap.ts";

const anonymous_private = 0x22;

for (const address_type of ["i32", "i64"] as const) {
  const address = (value: number) => (address_type === "i64" ? BigInt(value) : value);

  test(`${address_type}: legacy mmap accepts allocation and ignores non-fixed hints`, () => {
    const calls: unknown[][] = [];
    const exports = {
      __wasm_mmap: (...args: unknown[]) => {
        calls.push(args);
        return address(0x20000);
      },
    };
    for (const hint of [0, 0x10000]) {
      assert.equal(
        user_mmap(
          exports,
          address_type,
          address(hint),
          address(65536),
          3,
          anonymous_private,
          -1,
          address(0),
        ),
        address(0x20000),
      );
    }
    assert.deepEqual(calls, [[address(65536)], [address(65536)]]);
  });

  test(`${address_type}: legacy mmap rejects fixed requests without allocating`, () => {
    let calls = 0;
    const exports = {
      __wasm_mmap: () => {
        calls++;
        return address(0x20000);
      },
    };
    for (const fixed of [0x10, 0x100000, 0x100010]) {
      assert.equal(
        user_mmap(
          exports,
          address_type,
          address(0x10000),
          address(65536),
          3,
          anonymous_private | fixed,
          -1,
          address(0),
        ),
        address(-12),
      );
    }
    assert.equal(calls, 0);
  });

  test(`${address_type}: legacy mmap rejects unsupported semantics and absent callbacks`, () => {
    const exports = {
      __wasm_mmap: () => {
        assert.fail("must not allocate");
      },
    };
    for (const [prot, flags, fd, offset] of [
      [1, anonymous_private, -1, 0],
      [3, 0x21, -1, 0],
      [3, 0x02, 0, 0],
      [3, anonymous_private | 0x4000, -1, 0],
      [3, anonymous_private, 0, 0],
      [3, anonymous_private, -1, 1],
    ] as const) {
      assert.equal(
        user_mmap(
          exports,
          address_type,
          address(0),
          address(65536),
          prot,
          flags,
          fd,
          address(offset),
        ),
        address(-22),
      );
    }
    assert.equal(
      user_mmap({}, address_type, address(0), address(65536), 3, anonymous_private, -1, address(0)),
      address(-38),
    );
  });

  test(`${address_type}: v2 mmap preserves the full request and takes precedence`, () => {
    const request = [
      address(address_type === "i64" ? 0x1_0001_0000 : 0x10000),
      address(65536),
      3,
      anonymous_private | 0x100000,
      -1,
      address(0),
    ] as const;
    const exports = {
      __wasm_mmap: () => {
        assert.fail("must use v2");
      },
      __wasm_mmap_v2: (...args: unknown[]) => {
        assert.deepEqual(args, request);
        return address(-17);
      },
    };
    assert.equal(user_mmap(exports, address_type, ...request), address(-17));
  });
}
