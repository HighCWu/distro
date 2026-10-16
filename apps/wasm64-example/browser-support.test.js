// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { assertBrowserSupport } from "./browser-support.js";

test("actual shared memory64 module instantiates on the host engine", () => {
  assert.doesNotThrow(() => assertBrowserSupport({ isolated: true }));
});

test("missing isolation fails before probing the engine", () => {
  assert.throws(() => assertBrowserSupport({ isolated: false, wasm: null }), /COOP\/COEP/);
});

test("missing shared buffers and unsupported engines have explicit diagnostics", () => {
  assert.throws(
    () => assertBrowserSupport({ isolated: true, sharedArrayBuffer: null }),
    /SharedArrayBuffer is required/,
  );
  for (const wasm of [null, { validate: () => false }])
    assert.throws(() => assertBrowserSupport({ isolated: true, wasm }), /shared memory64 support/);
});

test("validation alone does not mask allocation failure", () => {
  const failure = new RangeError("allocation failed");
  const wasm = {
    validate: () => true,
    Module: WebAssembly.Module,
    Instance: class {
      constructor() {
        throw failure;
      }
    },
  };
  assert.throws(
    () => assertBrowserSupport({ isolated: true, wasm }),
    (error) => /allocate.*probe/.test(error.message) && error.cause === failure,
  );
});

test("an engine returning ordinary shared memory32 cannot pass the probe", () => {
  const wasm = {
    validate: () => true,
    Module: WebAssembly.Module,
    Instance: class {
      exports = { memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }) };
    },
  };
  assert.throws(() => assertBrowserSupport({ isolated: true, wasm }), /allocate.*probe/);
});
