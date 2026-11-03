// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { clone3_fork_request, clone_fork_request } from "../src/clone3-args.ts";

for (const address of ["i32", "i64"] as const)
  test(`${address}: flags-first clone options keep the Linux word layout`, () => {
    const p = (n: number) => (address === "i64" ? BigInt(n) : n);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const parse = (args: number[]) => clone_fork_request(memory, address, args.map(p));
    assert.deepEqual(parse([17 | 0x40000, 0, 0, 0, 0, 0]), {
      pidfd: null,
      sharingFlags: p(0x40000),
    });
    assert.deepEqual(parse([17 | 0x600, 0, -1, -1, -1, -1]), {
      pidfd: null,
      sharingFlags: p(0x600),
    });
    assert.deepEqual(parse([17, 0, 0, 0, 0, 999]), { pidfd: null });
    if (address === "i64")
      assert.deepEqual(
        clone_fork_request(memory, address, [(1n << 40n) | 17n, 0n, -1n, -1n, -1n, 999n]),
        { pidfd: null },
        "legacy flags ignore upper bits without narrowing pointer arguments",
      );
    if (address === "i64")
      assert.equal(
        clone_fork_request(memory, address, [0x1011n, 0n, (1n << 32n) | 8193n, 0n, 0n, 0n]),
        -14,
        "legacy PIDFD pointers keep their high bits",
      );
    assert.deepEqual(parse([17 | 0x1000, 0, 8193, 0, 0, 0]), { pidfd: p(8193) });
    assert.deepEqual(parse([17 | 0x0c020000, 0, 0, 0, 0, 0]), {
      pidfd: null,
      namespaceFlags: p(0x0c020000),
    });
    assert.deepEqual(parse([17 | 0x0c021000, 0, 8193, 0, 0, 0]), {
      pidfd: p(8193),
      namespaceFlags: p(0x0c020000),
    });
    for (const flags of [0, 7, 17 | 0x80, 17 | 0x100, 17 | 0x80000])
      assert.equal(parse([flags, 0, 0, 0, 0, 0]), -95);
    assert.deepEqual(
      parse([17, 0, -1, -1, -1, 999]),
      { pidfd: null },
      "unrequested words are ignored",
    );
    assert.equal(
      parse([17, 8, 0, 0, 0, 0]),
      -95,
      "alternate user stack is not a fork continuation",
    );
    for (const pointer of [0, -1, 65533])
      assert.equal(parse([17 | 0x1000, 0, pointer, 0, 0, 0]), -14);
    assert.equal(parse([0, 0, 17, 0, 0, 0]), -95, "callback tuple is never guessed as flags-first");
    assert.equal(parse([17, 0, 0, 0, 0]), -95);
  });

for (const address of ["i32", "i64"] as const)
  test(`${address}: bounded clone3 u64 layout and rejection`, () => {
    const p = (n: number) => (address === "i64" ? BigInt(n) : n);
    const memory = new WebAssembly.Memory({ initial: 2 });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    const reset = () => {
      bytes.fill(0);
      view.setBigUint64(256 + 32, 17n, true);
    };
    const parse = (size: number, pointer = 256) =>
      clone3_fork_request(memory, address, p(pointer), p(size));
    reset();
    view.setBigUint64(256, 0x20600n, true);
    assert.deepEqual(parse(88), {
      pidfd: null,
      namespaceFlags: p(0x20000),
      sharingFlags: p(0x600),
    });
    reset();
    for (const size of [64, 65, 72, 80, 88, 96, 65536])
      assert.deepEqual(parse(size), { pidfd: null });
    for (const flags of [
      0x20000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000, 0x7e020000,
    ]) {
      reset();
      view.setBigUint64(256, BigInt(flags), true);
      assert.deepEqual(parse(88), { pidfd: null, namespaceFlags: p(flags) });
    }
    reset();
    view.setBigUint64(256, 0x100000000n, true);
    assert.deepEqual(
      parse(88),
      { pidfd: null, flags64: 0x100000000n },
      "clone3 high flags retain their full u64 on both pointer widths",
    );
    reset();
    for (const size of [0, 1, 63]) assert.equal(parse(size), -22);
    for (const size of [65537, -1]) assert.equal(parse(size), -7);
    for (const pointer of [0, -1, 131072 - 63]) assert.equal(parse(64, pointer), -14);
    for (const [index, value, error] of [
      [0, 17n, -22],
      [0, 0x100n, -95],
      [0, 0x100000800n, -22],
      [4, 0n, -95],
      [4, 65n, -22],
      [4, 0x100000011n, -22],
      [5, 1n, -22],
      [6, 1n, -22],
      [8, 1n, -22],
      [9, 1n, -22],
      [11, 1n, -7],
    ] as const) {
      reset();
      view.setBigUint64(256 + index * 8, value, true);
      assert.equal(parse(96), error, `field ${index}`);
    }
    reset();
    for (const index of [1, 2, 3, 7, 10])
      view.setBigUint64(256 + index * 8, 0xffffffffffffffffn, true);
    for (const size of [64, 80, 88, 96])
      assert.deepEqual(
        parse(size),
        { pidfd: null },
        "unrequested output and TLS fields are ignored",
      );
    view.setBigUint64(256, 0x100000n, true);
    view.setBigUint64(256 + 24, 8193n, true);
    assert.deepEqual(
      parse(88),
      { pidfd: null, tids: { flags: p(0x100000), parent: p(8193), child: p(0) } },
      "only the requested parent TID is captured",
    );
    view.setBigUint64(256 + 24, 0xffffffffffffffffn, true);
    if (address === "i32") assert.equal(parse(88), -14, "requested pointer still cannot narrow");
    reset();
    view.setBigUint64(256 + 80, 0xffffffffffffffffn, true);
    assert.deepEqual(parse(88), { pidfd: null }, "unrequested cgroup fd is ignored by Linux");
    view.setBigUint64(256, 0x200000000n, true);
    assert.equal(parse(80), -22, "cgroup requires the full VER2 structure");
    assert.equal(parse(88), -22, "fd must fit Linux int without narrowing");
    for (const fd of [0n, 19n, 0x7fffffffn]) {
      view.setBigUint64(256 + 80, fd, true);
      assert.deepEqual(parse(88), { pidfd: null, flags64: 0x200000000n, cgroup: fd });
    }
    reset();
    view.setBigUint64(256 + 64, 8193n, true);
    view.setBigUint64(256 + 72, 2n, true);
    view.setInt32(8193, 60001, true);
    view.setInt32(8197, -19, true);
    const captured = parse(88);
    assert.deepEqual(captured, { pidfd: null, setTid: [60001, -19] });
    view.setInt32(8193, 9, true);
    assert.deepEqual(
      captured,
      { pidfd: null, setTid: [60001, -19] },
      "capture is independent of user frames",
    );
    for (const bad of [131071n, 0x100000001n, 1n << 55n]) {
      view.setBigUint64(256 + 64, bad, true);
      assert.equal(parse(88), -14);
    }
    view.setBigUint64(256 + 72, 33n, true);
    assert.equal(parse(88), -22);
    reset();
    view.setBigUint64(256, 0x80n, true);
    assert.deepEqual(parse(88), { pidfd: null, flags64: 0x80n }, "NEWTIME is clone3-only");
    view.setBigUint64(256, 0x100000080n, true);
    assert.deepEqual(parse(88), { pidfd: null, flags64: 0x100000080n });
    reset();
    view.setBigUint64(256 + 64, 1n, true);
    assert.deepEqual(parse(64), { pidfd: null }, "bytes outside the supplied size are not read");
    reset();
    view.setBigUint64(256 + 40, 1024n, true);
    view.setBigUint64(256 + 48, 16n, true);
    assert.equal(parse(88), -95, "valid alternate stacks remain unsupported");
    assert.equal(
      clone3_fork_request(memory, address, address === "i64" ? 1n << 55n : -8, p(88)),
      -14,
    );
    reset();
    view.setBigUint64(256, 0x1000n, true);
    for (const pointer of [0n, 131069n, 1n << 32n, 1n << 55n]) {
      view.setBigUint64(264, pointer, true);
      assert.equal(parse(88), -14, "invalid full-width pidfd output pointer");
    }
    view.setBigUint64(264, 8193n, true);
    view.setInt32(8193, -1, true);
    assert.deepEqual(parse(64), { pidfd: p(8193) }, "unaligned user output is valid");
    assert.equal(view.getInt32(8193, true), -1, "parser does not allocate/write a pidfd");
    view.setBigUint64(256, 0x1000n | 0x4000000n, true);
    assert.deepEqual(parse(88), { pidfd: p(8193), namespaceFlags: p(0x4000000) });
    view.setBigUint64(256, 0x1000n | 0x100000n, true);
    view.setBigUint64(280, 8200n, true);
    assert.deepEqual(
      parse(88),
      { pidfd: p(8193), tids: { flags: p(0x100000), parent: p(8200), child: p(0) } },
      "clone3 preserves separate PIDFD and parent TID outputs",
    );
    view.setBigUint64(256, 0x01300000n, true);
    view.setBigUint64(264, 0n, true);
    view.setBigUint64(272, 8216n, true);
    assert.deepEqual(parse(88), {
      pidfd: null,
      tids: { flags: p(0x01300000), parent: p(8200), child: p(8216) },
    });
    assert.deepEqual(
      clone_fork_request(memory, address, [p(0x01300011), p(0), p(8200), p(8216), p(-1), p(999)]),
      { pidfd: null, tids: { flags: p(0x01300000), parent: p(8200), child: p(8216) } },
    );
    if (address === "i32") {
      view.setBigUint64(280, 0x100000000n, true);
      assert.equal(parse(88), -14, "a TID pointer is never truncated to wasm32");
    }
  });
