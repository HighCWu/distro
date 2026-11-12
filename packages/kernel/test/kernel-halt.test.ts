// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { create_wasm_halt, HALT_KERNEL } from "../src/kernel-halt.ts";

// (module (import "host" "stop" (func $stop))
//   (func (export "run") (result i32)
//     (try (result i32) (do (call $stop) (i32.const 0))
//       (catch_all (i32.const 1)))))
const catcher = new WebAssembly.Module(
  new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x60, 0x00, 0x00, 0x60, 0x00,
    0x01, 0x7f, 0x02, 0x0d, 0x01, 0x04, 0x68, 0x6f, 0x73, 0x74, 0x04, 0x73, 0x74, 0x6f, 0x70, 0x00,
    0x00, 0x03, 0x02, 0x01, 0x01, 0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x01, 0x0a, 0x0e,
    0x01, 0x0c, 0x00, 0x06, 0x7f, 0x10, 0x00, 0x41, 0x00, 0x19, 0x41, 0x01, 0x0b, 0x0b,
  ]),
);

function invoke(stop: () => never): number {
  const instance = new WebAssembly.Instance(catcher, { host: { stop } });
  return (instance.exports.run as () => number)();
}

test("ordinary host exceptions can enter Wasm application handlers", () => {
  for (const error of [Symbol("halt"), new WebAssembly.RuntimeError("halt")]) {
    assert.equal(
      invoke(() => {
        throw error;
      }),
      1,
    );
  }
});

test("kernel halt bypasses Wasm handlers through a JavaScript bridge", () => {
  assert.ok(HALT_KERNEL instanceof WebAssembly.RuntimeError);
  assert.throws(
    () =>
      invoke(() => {
        try {
          throw HALT_KERNEL;
        } catch (error) {
          throw error;
        }
      }),
    (error) => error === HALT_KERNEL,
  );
});

test("user halt uses a distinct uncatchable Wasm trap identity", () => {
  const HALT_USER = create_wasm_halt();
  assert.ok(HALT_USER instanceof WebAssembly.RuntimeError);
  assert.notEqual(HALT_USER, HALT_KERNEL);
  assert.notEqual(HALT_USER, create_wasm_halt());
  assert.throws(
    () =>
      invoke(() => {
        try {
          throw HALT_USER;
        } catch (error) {
          throw error;
        }
      }),
    (error) => error === HALT_USER,
  );
});
