// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { ByteReader, chunked_body, fixed_body } from "../src/http.ts";

const encoder = new TextEncoder();
function borrowedSource(text: string, size: number, slab: Uint8Array = new Uint8Array(size)) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset === bytes.length) {
          controller.close();
          return;
        }
        const length = Math.min(size, bytes.length - offset);
        slab.set(bytes.subarray(offset, offset + length));
        offset += length;
        controller.enqueue(slab.subarray(0, length));
      },
    },
    { highWaterMark: 0 },
  );
}

for (const [name, slab] of [
  ["Uint8Array", new Uint8Array(3)],
  ["Buffer", Buffer.alloc(3)],
] as const) {
  test(`HTTP reader output remains stable after the producer reuses its ${name} slab`, async () => {
    const reader = new ByteReader(borrowedSource("abcdef", 3, slab));
    try {
      const first = await reader.take(3);
      const second = await reader.take(3);
      assert.equal(new TextDecoder().decode(first), "abc");
      assert.equal(new TextDecoder().decode(second), "def");
    } finally {
      await reader.cancel();
      reader.detach();
    }
  });
}

for (const framing of ["fixed", "chunked"] as const) {
  test(`HTTP ${framing} framing survives reused buffers across headers and body`, async () => {
    const body = framing === "fixed" ? "hello" : "2\r\nhe\r\n3\r\nllo\r\n0\r\n\r\n";
    const wire = `POST / HTTP/1.1\r\nHost: example.test\r\n\r\n${body}`;
    const reader = new ByteReader(borrowedSource(wire, 3), { strictCrlf: true });
    try {
      const head = await reader.head();
      assert.equal(head!.line, "POST / HTTP/1.1");
      assert.equal(head!.headers.get("host"), "example.test");
      const stream = framing === "fixed" ? fixed_body(reader, 5) : chunked_body(reader);
      const consumer = stream.getReader();
      const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const { value, done } = await consumer.read();
          if (done) break;
          chunks.push(value);
        }
      } finally {
        consumer.releaseLock();
      }
      // Retain output chunks until decoding finishes, rather than hiding
      // aliasing through an eager consumer-side copy.
      assert.equal(chunks.map((bytes) => new TextDecoder().decode(bytes)).join(""), "hello");
    } finally {
      await reader.cancel();
      reader.detach();
    }
  });
}
