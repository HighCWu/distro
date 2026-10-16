// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { collect, console_line_output, expect_ready_message } from "./helpers.ts";

for (const newline of ["\n", "\r\n"]) {
  test(`console readiness consumes complete ${JSON.stringify(newline)} lines across chunks`, async () => {
    const lines: string[] = [];
    const logged: string[] = [];
    const writer = console_line_output((line) => lines.push(line), {
      write(text) {
        logged.push(text);
      },
    }).getWriter();
    const bytes = new TextEncoder().encode(
      `kernel ✓${newline}agent-wasm64-runtime: ready${newline}`,
    );
    for (const byte of bytes) await writer.write(Uint8Array.of(byte));
    await writer.close();
    assert.deepEqual(lines, ["kernel ✓", "agent-wasm64-runtime: ready"]);
    assert.deepEqual(logged, ["kernel ✓\n", "agent-wasm64-runtime: ready\n"]);
  });
}

test("console streams do not merge partial lines or accept an unterminated ready fragment", async () => {
  const lines: string[] = [];
  const logged: string[] = [];
  const output = {
    write(text: string) {
      logged.push(text);
    },
  };
  const first = console_line_output((line) => lines.push(line), output).getWriter();
  const second = console_line_output((line) => lines.push(line), output).getWriter();
  const encode = (text: string) => new TextEncoder().encode(text);
  await first.write(encode("boot"));
  await second.write(encode("agent-wasm64-runtime: ready\r"));
  assert.deepEqual(lines, []);
  await first.write(encode(" message\n"));
  await second.write(encode("\nagent-wasm64-runtime: ready"));
  assert.deepEqual(lines, ["boot message", "agent-wasm64-runtime: ready"]);
  await Promise.all([first.close(), second.close()]);
  assert.equal(lines.length, 2);
  assert.equal(logged.at(-1), "agent-wasm64-runtime: ready\n");
});

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

test("collection reads remaining bytes after a readiness reader releases its lock", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("listening\n"));
      controller.enqueue(new TextEncoder().encode("remaining"));
      controller.close();
    },
  });
  await expect_ready_message(stream, "listening\n");
  assert.equal(new TextDecoder().decode(await collect(stream)), "remaining");
  assert.equal(stream.locked, false);
});

test("collection accepts a disturbed stream with no remaining bytes", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("listening\n"));
      controller.close();
    },
  });
  await expect_ready_message(stream, "listening\n");
  assert.deepEqual(await collect(stream), new Uint8Array());
  assert.equal(stream.locked, false);
});

test("collection copies reused Buffer views before the next pull", async () => {
  const backing = Buffer.alloc(4);
  let count = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (count === 3) return controller.close();
        backing.fill(++count);
        controller.enqueue(backing.subarray(1, 3));
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(await collect(stream), Uint8Array.of(1, 1, 2, 2, 3, 3));
  assert.equal(stream.locked, false);
});

test("collection preserves read failures and releases the reader lock", async () => {
  const reason = new Error("output failed");
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(reason);
    },
  });
  await assert.rejects(collect(stream), (error) => error === reason);
  assert.equal(stream.locked, false);
});

test("collection rejects a stream that still has an owner", async () => {
  const stream = new ReadableStream<Uint8Array>();
  const reader = stream.getReader();
  try {
    await assert.rejects(collect(stream), TypeError);
    assert.equal(stream.locked, true);
  } finally {
    reader.releaseLock();
    await stream.cancel();
  }
});
