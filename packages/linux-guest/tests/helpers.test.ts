// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { expect_ready_message } from "./helpers.ts";

test("readiness accepts split output and releases the stream lock", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const text of ["listen", "ing\n"]) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  await expect_ready_message(stream, "listening\n");
  assert.equal(stream.locked, false);
});

for (const output of ["", "wrong\n"]) {
  test(`readiness rejects ${output ? "unexpected output" : "early EOF"}`, async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(output));
        controller.close();
      },
    });
    await assert.rejects(expect_ready_message(stream, "listening\n"), /readiness/);
    assert.equal(stream.locked, false);
  });
}

test("readiness times out without leaving the stream locked", async () => {
  const stream = new ReadableStream<Uint8Array>();
  await assert.rejects(expect_ready_message(stream, "listening\n", 10), /timed out/);
  assert.equal(stream.locked, false);
  await stream.cancel();
});
