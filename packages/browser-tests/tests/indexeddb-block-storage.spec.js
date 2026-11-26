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

test("reopens a zero-backed persistent disk without changing its capacity", async ({ page }) => {
  await page.route("**/indexeddb-local-test.html", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/indexeddb-local-test.html");
  const result = await page.evaluate(async () => {
    const { exportIndexedDbBlockStorage, openIndexedDbBlockStorage } =
      await import("/node_modules/@lowland/kernel/dist/virtio/indexeddb-block-storage.js");
    const name = `local-${crypto.randomUUID()}`;
    const capacity = 4096;
    const databaseName = `linux-wasm-local-block:${name}`;
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const refused = async (bytes) => {
      let unexpected;
      try {
        unexpected = await openIndexedDbBlockStorage(name, bytes);
        return null;
      } catch (error) {
        return error.message;
      } finally {
        await unexpected?.close();
      }
    };
    const read = async (storage) => {
      const bytes = new Uint8Array(capacity).fill(0xff);
      if ((await storage.read(0, bytes)) !== capacity) throw new Error("short local disk read");
      return bytes;
    };
    const refuseExport = async (bytes) => {
      let touched = false;
      const destination = new WritableStream({
        write() {
          touched = true;
        },
        close() {
          touched = true;
        },
        abort() {
          touched = true;
        },
      });
      try {
        await exportIndexedDbBlockStorage(name, bytes, destination);
        throw new Error("disk export unexpectedly succeeded");
      } catch (error) {
        if (touched || destination.locked) throw error;
        return error.message;
      }
    };

    let storage;
    try {
      const invalidCapacity = await refused(513);
      const missingExport = await refuseExport(capacity);
      const createdByExport = (await indexedDB.databases()).some(
        ({ name }) => name === databaseName,
      );
      storage = await openIndexedDbBlockStorage(name, capacity);
      const startsZero = (await read(storage)).every((byte) => byte === 0);
      const locked = await refused(capacity);
      const lockedExport = await refuseExport(capacity);
      await storage.write(511, Uint8Array.of(0x31, 0x32, 0x33, 0x34));
      await storage.write(513, Uint8Array.of(0x35, 0x36));
      await storage.writeZeroes(512, 2);
      await storage.write(1024, Uint8Array.of(0x41));
      await storage.discard(1024, 512);
      await storage.write(1536, Uint8Array.of(0x42));
      await storage.writeZeroes(1536, 512);
      await storage.flush();
      await storage.close();

      const mismatch = await refused(capacity + 512);
      const mismatchExport = await refuseExport(capacity + 512);
      storage = await openIndexedDbBlockStorage(name, capacity);
      const reopened = (await read(storage)).every(
        (byte, index) => byte === (index === 511 ? 0x31 : index === 514 ? 0x36 : 0),
      );
      const count = storage.capacity;
      await storage.close();

      const db = await requestResult(indexedDB.open(databaseName));
      try {
        const sectors = db.transaction("sectors", "readonly").objectStore("sectors");
        const allocated = await requestResult(sectors.getAllKeys());
        return {
          count,
          startsZero,
          invalidCapacity,
          locked,
          mismatch,
          reopened,
          allocated,
          missingExport,
          createdByExport,
          lockedExport,
          mismatchExport,
        };
      } finally {
        db.close();
      }
    } finally {
      await storage?.close();
      await requestResult(indexedDB.deleteDatabase(databaseName));
    }
  });

  expect(result).toEqual({
    count: 4096,
    startsZero: true,
    invalidCapacity: "persistent IndexedDB disk capacity must be a positive sector multiple",
    locked: "persistent IndexedDB disk is already open",
    mismatch: "persistent IndexedDB disk capacity mismatch",
    missingExport: "persistent IndexedDB disk does not exist",
    createdByExport: false,
    lockedExport: "persistent IndexedDB disk is already open",
    mismatchExport: "persistent IndexedDB disk capacity mismatch",
    reopened: true,
    allocated: [0, 1],
  });
});
