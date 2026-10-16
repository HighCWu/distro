// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { hostFetchNetwork } from "../src/host-fetch-network.ts";

test(
  "disconnect while waiting for request headers cancels the input",
  { timeout: 1000 },
  async () => {
    const abort = new AbortController();
    const reason = new Error("partial request disconnected");
    let cancelled: unknown;
    let pulled!: () => void;
    const ready = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("GET / HTTP/1.1\r\nHost:"));
      },
      pull() {
        pulled();
      },
      cancel(value) {
        cancelled = value;
      },
    });
    const writable = new WritableStream<Uint8Array>({
      write() {
        assert.fail("must not reply after abort");
      },
    });
    const network = hostFetchNetwork({
      fetch() {
        assert.fail("incomplete request must not dispatch");
      },
    });
    const handled = Promise.resolve(
      network.connectTcp!({
        target: { hostname: "198.18.0.1", port: 80 },
        signal: abort.signal,
        readable,
        writable,
      }),
    );
    const rejected = assert.rejects(handled, (error) => error === reason);
    await ready;
    abort.abort(reason);
    await rejected;
    assert.equal(cancelled, reason);
    assert.equal(readable.locked, false);
    assert.equal(writable.locked, false);
  },
);

test("an already aborted connection never invokes the Fetch callback", async () => {
  const abort = new AbortController();
  const reason = new Error("already disconnected");
  abort.abort(reason);
  let calls = 0;
  const network = hostFetchNetwork({
    fetch() {
      calls++;
      return new Response("must not send");
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          "POST /change HTTP/1.1\r\nHost: example.test\r\nContent-Length: 0\r\n\r\n",
        ),
      );
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write() {
      assert.fail("must not reply");
    },
  });
  await assert.rejects(
    Promise.resolve(
      network.connectTcp!({
        target: { hostname: "198.18.0.1", port: 80 },
        signal: abort.signal,
        readable,
        writable,
      }),
    ),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
});

test("a response returned after disconnect is cancelled without writing an HTTP reply", async () => {
  const abort = new AbortController();
  const reason = new Error("closed while fetching");
  let cancelCount = 0;
  let writes = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelCount++;
    },
  });
  const network = hostFetchNetwork({
    fetch() {
      started();
      return response;
    },
  });
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"));
      controller.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write() {
      writes++;
    },
  });
  const handled = Promise.resolve(
    network.connectTcp!({
      target: { hostname: "198.18.0.1", port: 80 },
      signal: abort.signal,
      readable,
      writable,
    }),
  );
  const rejected = assert.rejects(handled, (error) => error === reason);
  await ready;
  abort.abort(reason);
  finish(new Response(body));
  await rejected;
  assert.equal(writes, 0);
  assert.equal(cancelCount, 1);
  assert.equal(body.locked, false);
  assert.equal(readable.locked, false);
  assert.equal(writable.locked, false);
});

test("connection abort cancels a pending custom response read", { timeout: 1000 }, async () => {
  const abort = new AbortController();
  const reason = new Error("connection closed");
  let cancelled: unknown;
  let headersWritten!: () => void;
  const ready = new Promise<void>((resolve) => {
    headersWritten = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    cancel(value) {
      cancelled = value;
    },
  });
  const network = hostFetchNetwork({ fetch: () => new Response(body) });
  const writable = new WritableStream<Uint8Array>({
    write() {
      headersWritten();
    },
  });
  const handled = Promise.resolve(
    network.connectTcp!({
      target: { hostname: "198.18.0.1", port: 80 },
      signal: abort.signal,
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"),
          );
          controller.close();
        },
      }),
      writable,
    }),
  );
  const rejected = assert.rejects(handled, (error) => error === reason);
  await ready;
  abort.abort(reason);
  await rejected;
  assert.equal(cancelled, reason);
  assert.equal(body.locked, false);
  assert.equal(writable.locked, false);
});

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
