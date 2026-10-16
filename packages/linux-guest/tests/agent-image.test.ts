// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { select_agent_image, type GuestAgentOptions } from "../src/agent-image.ts";

test("default agent selection keeps the packaged wasm32 image and legacy handshake", () => {
  assert.deepEqual(select_agent_image({}), { abi: undefined, image: undefined });
  assert.deepEqual(select_agent_image({ abi: "wasm32" }), { abi: "wasm32", image: undefined });
});

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`custom ${abi} agent selection snapshots only the supplied byte view`, () => {
    const bytes = new Uint8Array(1024).fill(9);
    bytes.subarray(256, 768).fill(7);
    const options: GuestAgentOptions = { abi, image: bytes.subarray(256, 768) };
    const selected = select_agent_image(options);
    options.abi = abi === "wasm64" ? "wasm32" : "wasm64";
    bytes.fill(0);
    assert.equal(selected.abi, abi);
    assert.deepEqual(selected.image, new Uint8Array(512).fill(7));
    assert.notEqual(selected.image!.buffer, bytes.buffer);
  });
}

test("ambiguous, mismatched or invalid agent selections fail before asset loading", () => {
  for (const options of [
    null,
    "wasm64",
    { abi: "wasm64" },
    { image: new Uint8Array(512) },
    { abi: "wasm64", image: new ArrayBuffer(512) },
  ]) {
    assert.throws(() => select_agent_image(options as GuestAgentOptions), TypeError);
  }
  for (const options of [
    { abi: "wasm128", image: new Uint8Array(512) },
    { abi: "wasm64", image: new Uint8Array() },
    { abi: "wasm32", image: new Uint8Array(513) },
  ]) {
    assert.throws(() => select_agent_image(options as GuestAgentOptions), RangeError);
  }
});
