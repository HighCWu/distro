// SPDX-License-Identifier: MIT
import type { BlockDeviceStorage } from "@lowland/kernel";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";
import { installHttpDiskStorage } from "../src/http-disk-storage.ts";

async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function install(url: string): Promise<BlockDeviceStorage> {
  let disk: BlockDeviceStorage | undefined;
  await installHttpDiskStorage(url, (storage) => {
    disk = storage;
  });
  assert.ok(disk);
  return disk;
}

test("HTTP disk pins the effective URL, strong validator, capacity and exact range bytes", async (t) => {
  const etag = '"image-v1"';
  const bytes = Uint8Array.from({ length: 1536 }, (_, index) => index % 251);
  const requests: unknown[][] = [];
  let responseMode: "ok" | "changed" | "resized" | "ignored" | "long" | "short" = "ok";
  const host = await serve(t, (request, response) => {
    requests.push([request.url, request.headers.range, request.headers["if-range"]]);
    if (request.url === "/entry") {
      response.writeHead(307, { Location: "/image" }).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
    if (request.url !== "/image" || !range) {
      response.writeHead(400).end();
      return;
    }
    const first = Number(range[1]);
    const last = Number(range[2]);
    const total = bytes.byteLength + (responseMode === "resized" ? 512 : 0);
    const version = responseMode === "changed" ? '"image-v2"' : etag;
    if (responseMode === "ignored") {
      response.writeHead(200, { ETag: version }).end(bytes);
      return;
    }
    response.writeHead(206, { ETag: version, "Content-Range": `bytes ${first}-${last}/${total}` });
    // Send without Content-Length to exercise validation of the streamed body.
    response.write(bytes.subarray(first, responseMode === "short" ? last : last + 1));
    response.end(responseMode === "long" ? Uint8Array.of(0xff) : undefined);
  });

  const disk = await install(`${host}/entry`);
  t.after(() => disk.stop?.());
  assert.equal(disk.capacity, bytes.byteLength);
  assert.equal(disk.write, undefined);
  assert.equal(disk.flush, undefined);

  const crossSector = new Uint8Array(18);
  assert.equal(await disk.read(509, crossSector), 18);
  assert.deepEqual(crossSector, bytes.slice(509, 527));
  const finalSector = new Uint8Array(512);
  assert.equal(await disk.read(1024, finalSector), 512);
  assert.deepEqual(finalSector, bytes.slice(1024));
  assert.equal(await disk.read(1536, new Uint8Array()), 0);
  await assert.rejects(async () => disk.read(1536, new Uint8Array(1)), /outside the image/);
  assert.deepEqual(requests, [
    ["/entry", "bytes=0-511", undefined],
    ["/image", "bytes=0-511", undefined],
    ["/image", "bytes=509-526", etag],
    ["/image", "bytes=1024-1535", etag],
  ]);

  for (const [mode, error] of [
    ["changed", /ETag changed/],
    ["resized", /capacity changed/],
    ["ignored", /expected status 206/],
    ["long", /body is too long/],
    ["short", /body is too short/],
  ] as const) {
    responseMode = mode;
    const untouched = Uint8Array.of(0x11, 0x22, 0x33, 0x44);
    await assert.rejects(async () => disk.read(2, untouched), error);
    assert.deepEqual(untouched, Uint8Array.of(0x11, 0x22, 0x33, 0x44));
    assert.deepEqual(requests.at(-1), ["/image", "bytes=2-5", etag]);
  }
});

test("HTTP disk discovery does not install an image without a strong ETag", async (t) => {
  const host = await serve(t, (_request, response) => {
    response.writeHead(206, { ETag: 'W/"image"', "Content-Range": "bytes 0-511/1024" });
    response.end(new Uint8Array(512));
  });
  await assert.rejects(install(host), /requires a strong ETag/);
});

test(
  "HTTP disk discovery times out when a server stalls the probe body",
  { timeout: 5000 },
  async (t) => {
    const bodyClosed = Promise.withResolvers<void>();
    const host = await serve(t, (_request, response) => {
      response.once("close", () => bodyClosed.resolve());
      response.writeHead(206, { ETag: '"image"', "Content-Range": "bytes 0-511/1024" });
      response.write(Uint8Array.of(3));
    });
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    t.mock.method(AbortSignal, "timeout", (milliseconds: number) =>
      realTimeout(milliseconds === 60_000 ? 500 : milliseconds),
    );
    await assert.rejects(install(host), { name: "TimeoutError" });
    await bodyClosed.promise;
  },
);

test(
  "HTTP disk stop aborts an in-flight range body and rejects further reads",
  { timeout: 5000 },
  async (t) => {
    const rangeStarted = Promise.withResolvers<void>();
    const rangeClosed = Promise.withResolvers<void>();
    let requests = 0;
    const host = await serve(t, (_request, response) => {
      requests++;
      if (requests === 1) {
        response.writeHead(206, { ETag: '"image"', "Content-Range": "bytes 0-511/1024" });
        response.end(new Uint8Array(512));
        return;
      }
      response.once("close", () => rangeClosed.resolve());
      response.writeHead(206, { ETag: '"image"', "Content-Range": "bytes 512-515/1024" });
      response.write(Uint8Array.of(3));
      rangeStarted.resolve();
    });

    const disk = await install(host);
    t.after(() => disk.stop?.());
    const target = Uint8Array.of(1, 2, 3, 4);
    const pending = assert.rejects(async () => disk.read(512, target), { name: "AbortError" });
    await rangeStarted.promise;
    disk.stop!();
    await pending;
    await rangeClosed.promise;
    assert.deepEqual(target, Uint8Array.of(1, 2, 3, 4));
    await assert.rejects(async () => disk.read(0, target), { name: "AbortError" });
    assert.equal(requests, 2);
  },
);
