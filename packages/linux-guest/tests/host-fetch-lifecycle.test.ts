// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { hostFetchNetwork } from "../src/host-fetch-network.ts";

for (const failedWrite of [1, 2]) {
  test(`downstream write ${failedWrite} failure cancels upstream and releases all stream locks`, async () => {
    const failure = new Error("downstream disconnected");
    let cancelled = 0;
    let writes = 0;
    let requestSignal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
      },
      cancel() {
        cancelled++;
        throw new Error("upstream cleanup failed");
      },
    });
    const network = hostFetchNetwork({
      fetch(request) {
        requestSignal = request.signal;
        return new Response(body);
      },
    });
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"),
        );
        controller.close();
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write() {
        if (++writes === failedWrite) throw failure;
      },
    });
    await assert.rejects(
      Promise.resolve(
        network.connectTcp!({
          target: { hostname: "198.18.0.1", port: 80 },
          signal: new AbortController().signal,
          readable,
          writable,
        }),
      ),
      (error) => error === failure,
    );
    assert.equal(writes, failedWrite);
    assert.equal(cancelled, 1);
    assert.equal(requestSignal?.aborted, true);
    assert.equal(body.locked, false);
    assert.equal(readable.locked, false);
    assert.equal(writable.locked, false);
  });
}

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
