// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import {
  user_mmap,
  user_mmap_fixed,
  user_mremap,
  user_mremap_fixed,
  user_msync,
  user_madvise,
} from "../src/user-mmap.ts";

const anonymous_private = 0x22;

for (const address_type of ["i32", "i64"] as const) {
  const address = (value: number) => (address_type === "i64" ? BigInt(value) : value);

  test(`${address_type}: fixed remap needs its own atomic export and retains all address registers`, () => {
    const pointer = address_type === "i64" ? 0x100010000n : -2147418112;
    const destination = address_type === "i64" ? 0x100080000n : -2146959360;
    const args = [pointer, address(65536), address(131072), destination] as const;
    const legacy = {
      __wasm_mremap: () => {
        throw new Error("must not resize through the old export");
      },
    };
    assert.equal(user_mremap_fixed(legacy, address_type, ...args), address(-38));
    let calls = 0;
    const exports = {
      ...legacy,
      __wasm_mremap_fixed: (...actual: unknown[]) => {
        assert.deepEqual(actual, args);
        return ++calls === 1 ? destination : address(-12);
      },
    };
    assert.equal(user_mremap_fixed(exports, address_type, ...args), destination);
    assert.equal(user_mremap_fixed(exports, address_type, ...args), address(-12));
  });

  test(`${address_type}: fixed replacement requires the new export, never legacy mmap`, () => {
    const pointer = address_type === "i64" ? 0x100010000n : -2147418112;
    const args = [pointer, address(65536)] as const;
    const legacy = {
      __wasm_mmap: () => {
        throw new Error("legacy length-only allocator");
      },
      __wasm_mmap_v2: () => {
        throw new Error("legacy request allocator");
      },
    };
    assert.equal(user_mmap_fixed(legacy, address_type, ...args), address(-38));
    let calls = 0;
    const exports = {
      ...legacy,
      __wasm_mmap_fixed: (...actual: unknown[]) => {
        assert.deepEqual(actual, args);
        return ++calls === 1 ? pointer : address(-12);
      },
    };
    assert.equal(user_mmap_fixed(exports, address_type, ...args), pointer);
    assert.equal(user_mmap_fixed(exports, address_type, ...args), address(-12));
  });

  test(`${address_type}: madvise requires allocator approval and preserves the pointer register`, () => {
    const pointer = address_type === "i64" ? 0x100010000n : -2147418112;
    const args = [pointer, address(65536), 4] as const;
    assert.equal(user_madvise({}, address_type, ...args), address(-38));
    let calls = 0;
    const exports = {
      __wasm_madvise: (...actual: unknown[]) => {
        calls++;
        assert.deepEqual(actual, args);
        return address(calls === 1 ? 0 : -95);
      },
    };
    assert.equal(user_madvise(exports, address_type, ...args), address(0));
    assert.equal(user_madvise(exports, address_type, ...args), address(-95));
    assert.equal(calls, 2);
  });

  test(`${address_type}: private msync forwards typed registers and refuses unknown allocator coverage`, () => {
    const pointer = address_type === "i64" ? 0x100010000n : -2147418112;
    const args = [pointer, address(65536), 4] as const;
    assert.equal(user_msync({}, address_type, ...args), address(-38));
    let calls = 0;
    const exports = {
      __wasm_msync: (...actual: unknown[]) => {
        calls++;
        assert.deepEqual(actual, args);
        return address(calls === 1 ? 0 : -12);
      },
    };
    assert.equal(user_msync(exports, address_type, ...args), address(0));
    assert.equal(user_msync(exports, address_type, ...args), address(-12));
    assert.equal(calls, 2);
  });

  test(`${address_type}: mremap preserves registers and old modules refuse without mmap fallback`, () => {
    const raw = address_type === "i64" ? 0x100010000n : -2147418112;
    const args = [raw, address(65536), address(131072), address(1)] as const;
    const legacy: WebAssembly.Exports[] = [
      {},
      { __wasm_mmap: () => assert.fail("no allocation fallback") },
    ];
    for (const exports of legacy)
      assert.equal(user_mremap(exports, address_type, ...args), address(-38));
    let calls = 0;
    const exports = {
      __wasm_mremap: (...actual: unknown[]) => {
        calls++;
        assert.deepEqual(actual, args);
        return calls === 1 ? raw : address(-12);
      },
    };
    assert.equal(user_mremap(exports, address_type, ...args), raw);
    assert.equal(user_mremap(exports, address_type, ...args), address(-12));
    assert.equal(calls, 2);
  });

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

  test(`${address_type}: anonymous READ is forwarded unchanged to v2 or the legacy data allocator`, () => {
    let calls = 0;
    const legacy = {
      __wasm_mmap: (length: number | bigint) => {
        calls++;
        assert.equal(length, address(65536));
        return address(0x20000);
      },
    };
    assert.equal(
      user_mmap(
        legacy,
        address_type,
        address(0),
        address(65536),
        1,
        anonymous_private,
        -1,
        address(0),
      ),
      address(0x20000),
    );
    assert.equal(calls, 1);
    const versioned = {
      __wasm_mmap_v2: (...args: (number | bigint)[]) => {
        assert.deepEqual(args, [address(0), address(65536), 1, anonymous_private, -1, address(0)]);
        return address(0x30000);
      },
      __wasm_mmap: () => assert.fail("v2 must take precedence"),
    };
    assert.equal(
      user_mmap(
        versioned,
        address_type,
        address(0),
        address(65536),
        1,
        anonymous_private,
        -1,
        address(0),
      ),
      address(0x30000),
    );
  });

  test(`${address_type}: legacy mmap rejects unsupported semantics and absent callbacks`, () => {
    const exports = {
      __wasm_mmap: () => {
        assert.fail("must not allocate");
      },
    };
    for (const [prot, flags, fd, offset] of [
      [0, anonymous_private, -1, 0],
      [2, anonymous_private, -1, 0],
      [4, anonymous_private, -1, 0],
      [5, anonymous_private, -1, 0],
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
