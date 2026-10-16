// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { compile_web_wasm } from "../src/web-wasm.ts";

const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
for (const mime of ["application/wasm", "application/octet-stream", undefined]) {
  test(`loads valid Wasm with MIME ${mime ?? "absent"}`, async () => {
    const response = new Response(emptyModule, {
      headers: mime ? { "Content-Type": mime } : {},
    });
    const result = await compile_web_wasm(response);
    assert.deepEqual(result.bytes, emptyModule);
    assert.ok(result.module instanceof WebAssembly.Module);
    assert.ok((await WebAssembly.instantiate(result.module)) instanceof WebAssembly.Instance);
  });
}

test("HTTP error is reported even if the body is valid Wasm", async () => {
  await assert.rejects(
    compile_web_wasm(
      new Response(emptyModule, {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/wasm" },
      }),
    ),
    /HTTP 404 Not Found/,
  );
});

test("invalid Wasm remains a compilation failure on both MIME paths", async () => {
  for (const mime of ["application/wasm", "application/octet-stream"]) {
    await assert.rejects(
      compile_web_wasm(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": mime },
        }),
      ),
      WebAssembly.CompileError,
    );
  }
});

test("body stream failure is propagated", async () => {
  for (const mime of ["application/wasm", "application/octet-stream"]) {
    const failure = new Error("download interrupted");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });
    await assert.rejects(
      compile_web_wasm(
        new Response(stream, {
          headers: { "Content-Type": mime },
        }),
      ),
      /download interrupted/,
    );
  }
});
