// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { hostFetchNetwork } from "../src/host-fetch-network.ts";

test("HEAD cancels an unused callback response body and releases its lock", async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const network = hostFetchNetwork({ fetch: () => new Response(body) });
  const chunks: Uint8Array[] = [];
  await network.connectTcp!({
    target: { hostname: "198.18.0.1", port: 80 },
    signal: new AbortController().signal,
    readable: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("HEAD / HTTP/1.1\r\nHost: example.test\r\n\r\n"),
        );
        controller.close();
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        chunks.push(chunk);
      },
    }),
  });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  const output = Buffer.concat(chunks).toString();
  assert.match(output, /^HTTP\/1\.1 200 /);
  assert.equal(output.split("\r\n\r\n")[1], "");
});
