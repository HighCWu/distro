// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";

test("discards persistent HTTP sectors without revealing the base image", async ({ page }) => {
  const capacity = 2 * 1024 * 1024;
  const etag = '"discard-base"';
  const ranges = [];
  await page.route("**/indexeddb-overlay-test.html", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.route("**/indexeddb-overlay-base.img", (route) => {
    const range = route.request().headers().range;
    ranges.push(range);
    const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(range);
    return route.fulfill({
      status: 206,
      headers: { "Content-Range": `bytes ${first}-${last}/${capacity}`, ETag: etag },
      body: Buffer.alloc(Number(last) - Number(first) + 1, 0x7b),
    });
  });
  await page.goto("/indexeddb-overlay-test.html");

  const result = await page.evaluate(
    async ({ capacity, etag }) => {
      const { openIndexedDbHttpBlockStorage } =
        await import("/node_modules/@lowland/kernel/dist/virtio/indexeddb-block-storage.js");
      const name = `discard-${crypto.randomUUID()}`;
      const databaseName = `linux-wasm-http-block:${name}`;
      const url = new URL("/indexeddb-overlay-base.img", location.href);
      const requestResult = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const transactionDone = (transaction) =>
        new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
      const read = async (storage, offset, length) => {
        const bytes = new Uint8Array(length).fill(0xff);
        if ((await storage.read(offset, bytes)) !== length) throw new Error("short overlay read");
        return bytes;
      };

      // Seed the v1 format directly so this covers a real schema upgrade.
      const old = indexedDB.open(databaseName, 1);
      old.onupgradeneeded = () => {
        const db = old.result;
        db.createObjectStore("metadata").put({ url: url.href, capacity, etag }, "image");
        const sectors = db.createObjectStore("sectors");
        sectors.put(new Uint8Array(512).fill(0x38), 0);
        sectors.put(new Uint8Array(512).fill(0x52), 2);
      };
      (await requestResult(old)).close();

      let storage;
      try {
        storage = await openIndexedDbHttpBlockStorage(url, name);
        const legacyPayload = (await read(storage, 0, 512)).every((byte) => byte === 0x38);
        const invalid = [];
        for (const [offset, length] of [
          [1, 512],
          [0, 1],
          [0, 1024 * 1024 + 512],
        ]) {
          try {
            await storage.discard(offset, length);
          } catch (error) {
            invalid.push(error.name);
          }
        }
        const [, discarded] = await Promise.all([storage.discard(0, 1024), read(storage, 0, 1024)]);
        const zeroBytes = discarded.every((byte) => byte === 0);
        await storage.write(513, Uint8Array.of(0x59));
        await storage.close();

        const db = await requestResult(indexedDB.open(databaseName, 2));
        let marker;
        try {
          const transaction = db.transaction("sectors", "readonly");
          const done = transactionDone(transaction);
          marker = await requestResult(transaction.objectStore("sectors").get(0));
          await done;
        } finally {
          db.close();
        }
        let oldOpenError;
        try {
          (await requestResult(indexedDB.open(databaseName, 1))).close();
        } catch (error) {
          oldOpenError = error.name;
        }

        storage = await openIndexedDbHttpBlockStorage(url, name);
        const mixed = await read(storage, 0, 2048);
        const reopened = mixed.every(
          (byte, index) =>
            byte === (index < 1024 ? (index === 513 ? 0x59 : 0) : index < 1536 ? 0x52 : 0x7b),
        );
        return { legacyPayload, invalid, zeroBytes, marker, oldOpenError, reopened };
      } finally {
        await storage?.close();
        await requestResult(indexedDB.deleteDatabase(databaseName));
      }
    },
    { capacity, etag },
  );

  expect(result).toEqual({
    legacyPayload: true,
    invalid: ["RangeError", "RangeError", "RangeError"],
    zeroBytes: true,
    marker: 0,
    oldOpenError: "VersionError",
    reopened: true,
  });
  expect(ranges).toEqual(["bytes=0-511", "bytes=0-511", "bytes=1536-2047"]);
});
