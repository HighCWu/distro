// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { readReadyOutput } from "./ready-output.ts";

test("readiness and trailing output retain one reader across chunks and UTF-8 boundaries", async () => {
  const bytes = new TextEncoder().encode("ready\n你好\nfinal\n");
  for (const cuts of [[bytes.length], [2, 7, 9, bytes.length], [6, bytes.length]]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let offset = 0;
        for (const end of cuts) {
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        }
        controller.close();
      },
    });
    const { output } = await readReadyOutput(stream, "ready");
    assert.equal(await output, "你好\nfinal\n");
    assert.equal(stream.locked, false);
  }
});

test("readiness returns before EOF so stdin can release a blocked program", async () => {
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      producer = controller;
    },
  });
  producer.enqueue(new TextEncoder().encode("ready\n"));
  const { output } = await readReadyOutput(stream, "ready");
  producer.enqueue(new TextEncoder().encode("after handshake\n"));
  producer.close();
  assert.equal(await output, "after handshake\n");
  assert.equal(stream.locked, false);
});

test("bad or missing readiness and errors after readiness remain failures", async () => {
  for (const text of ["wrong\n", "incomplete"]) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    await assert.rejects(readReadyOutput(stream, "ready"), /readiness/);
    assert.equal(stream.locked, false);
  }
  let producer!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      producer = controller;
    },
  });
  producer.enqueue(new TextEncoder().encode("ready\n"));
  const { output } = await readReadyOutput(stream, "ready");
  producer.error(new Error("late pipe failure"));
  await assert.rejects(output, /late pipe failure/);
  assert.equal(stream.locked, false);
});
