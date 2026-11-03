// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { user_brk_layout, user_brk_update } from "../src/user-brk.ts";

for (const address of ["i32", "i64"] as const) {
  test(`${address}: immutable user heap offsets become independent u64 kernel fields`, () => {
    const user = new WebAssembly.Memory({ initial: 1 });
    const kernel = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(kernel.buffer).fill(0x5a);
    const view = new DataView(user.buffer);
    const fields = [65536n, 1024n, 2048n];
    fields.forEach((value, index) =>
      address === "i64"
        ? view.setBigUint64(128 + index * 8, value, true)
        : view.setUint32(128 + index * 4, Number(value), true),
    );
    const word = (value: number) => (address === "i64" ? BigInt(value) : value);
    const exports = {
      __wasm_brk_layout_v1: () => word(128),
      __wasm_brk_update_v1: (requested: number | bigint) => requested,
    } as WebAssembly.Exports;
    assert.equal(user_brk_layout(exports, user, address, kernel, 256), 0);
    const output = new DataView(kernel.buffer);
    assert.deepEqual(
      fields.map((_, index) => output.getBigUint64(256 + index * 8, true)),
      fields,
    );
    assert.equal(output.getUint8(255), 0x5a);
    assert.equal(output.getUint8(280), 0x5a);
    assert.equal(user_brk_update(exports, address, word(70000)), word(70000));
    const before = new Uint8Array(kernel.buffer).slice();
    assert.equal(
      user_brk_layout(
        { ...exports, __wasm_brk_layout_v1: () => word(65535) },
        user,
        address,
        kernel,
        256,
      ),
      -14,
    );
    assert.deepEqual(new Uint8Array(kernel.buffer), before);
    assert.equal(user_brk_layout(exports, user, address, kernel, 65535), -14);
    assert.deepEqual(new Uint8Array(kernel.buffer), before);
    assert.equal(user_brk_layout({}, user, address, kernel, 256), -38);
    assert.equal(user_brk_update({}, address, word(70000)), word(-38));
    const control = Symbol("callback exit/exec");
    assert.throws(
      () =>
        user_brk_layout(
          {
            ...exports,
            __wasm_brk_layout_v1: () => {
              throw control;
            },
          },
          user,
          address,
          kernel,
          256,
        ),
      (error) => error === control,
    );
  });
}
