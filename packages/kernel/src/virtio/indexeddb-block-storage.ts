// SPDX-License-Identifier: MIT
import type { BlockDeviceStorage } from "./block.ts";
import { type HttpImage, openPinnedHttpBlockStorage } from "./http-block-storage.ts";

const SECTOR_BYTES = 512;
const MAX_DISCARD_BYTES = 1024 * 1024;
const EXPORT_CHUNK_BYTES = 1024 * 1024;
const IDENTITY_KEY = "image";
const CAPACITY_KEY = "capacity";
const DATABASE_VERSION = 2;
// A missing record still reads from the pinned HTTP image. An explicit
// marker masks that sector without retaining its former 512-byte payload.
const ZERO_SECTOR = 0;
type SectorValue = Uint8Array | typeof ZERO_SECTOR;

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("disk transaction aborted"));
    transaction.onerror = () => {}; // The abort event reports the final result.
  });
}

function openDatabase(
  name: string,
  description: string,
  existingOnly: boolean,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DATABASE_VERSION);
    let abandoned = false;
    let openingError: Error | undefined;
    request.onupgradeneeded = ({ oldVersion }) => {
      if (abandoned || existingOnly) {
        if (existingOnly)
          openingError = new Error(
            `${description} ${oldVersion ? "database version mismatch" : "does not exist"}`,
          );
        // Export aborts any attempted creation or schema upgrade.
        request.transaction?.abort();
        return;
      }
      // Version 2 adds a sector value and keeps all version 1 records.
      // Runtimes requesting version 1 cannot open a database with markers.
      if (oldVersion === 0) {
        request.result.createObjectStore("metadata");
        request.result.createObjectStore("sectors");
      }
    };
    request.onerror = () => reject(openingError ?? request.error);
    request.onblocked = () => {
      abandoned = true;
      reject(new Error(`${description} database is blocked`));
    };
    request.onsuccess = () => {
      if (abandoned) request.result.close();
      else resolve(request.result);
    };
  });
}

/**
 * Opens a persistent writable sector overlay over a strongly pinned HTTP image.
 * The name identifies origin-local IndexedDB storage and requires an exclusive
 * Web Lock. Reopening a name with a different image fails without deleting data.
 * Writes await strict IndexedDB transaction commit; browser storage remains
 * subject to the origin's quota and eviction policy. Close releases the lock.
 */
export async function openIndexedDbHttpBlockStorage(
  url: string | URL,
  name: string,
): Promise<BlockDeviceStorage> {
  return openPersistentBlockStorage(name, "linux-wasm-http-block", "persistent HTTP disk", () =>
    openPinnedHttpBlockStorage(url),
  );
}

/**
 * Opens an origin-local writable disk whose unallocated sectors read as zeroes.
 * A name retains its original capacity across opens. Writes await strict
 * IndexedDB transaction commit and remain subject to browser quota and eviction.
 * Close releases the exclusive Web Lock.
 */
export async function openIndexedDbBlockStorage(
  name: string,
  capacity: number,
): Promise<BlockDeviceStorage> {
  return openLocalBlockStorage(name, capacity, false);
}

/**
 * Writes an existing, closed local disk to a raw image stream, including zero
 * bytes for its unallocated sectors. The disk remains exclusively locked
 * during export. The destination is closed on success and aborted on failure
 * once its writer has been acquired.
 */
export async function exportIndexedDbBlockStorage(
  name: string,
  capacity: number,
  destination: WritableStream<Uint8Array>,
): Promise<void> {
  const storage = await openLocalBlockStorage(name, capacity, true);
  try {
    const writer = destination.getWriter();
    try {
      for (let offset = 0; offset < capacity;) {
        const length = Math.min(EXPORT_CHUNK_BYTES, capacity - offset);
        const bytes = new Uint8Array(length);
        if ((await storage.read(offset, bytes)) !== length)
          throw new Error("persistent IndexedDB disk export encountered a short read");
        await writer.write(bytes);
        offset += length;
      }
      await writer.close();
    } catch (error) {
      // The destination's cleanup may block indefinitely. Release both locks
      // while its abort promise settles and report the original export error.
      void writer.abort(error).catch(() => {});
      throw error;
    } finally {
      writer.releaseLock();
    }
  } finally {
    await storage.close?.();
  }
}

function openLocalBlockStorage(
  name: string,
  capacity: number,
  existingOnly: boolean,
): Promise<BlockDeviceStorage> {
  if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity % SECTOR_BYTES !== 0)
    throw new RangeError("persistent IndexedDB disk capacity must be a positive sector multiple");
  return openPersistentBlockStorage(
    name,
    "linux-wasm-local-block",
    "persistent IndexedDB disk",
    () => ({ capacity }),
    existingOnly,
  );
}

async function openPersistentBlockStorage(
  name: string,
  prefix: string,
  description: string,
  prepare: () => { capacity: number } | Promise<{ image: HttpImage; storage: BlockDeviceStorage }>,
  existingOnly = false,
): Promise<BlockDeviceStorage> {
  if (typeof name !== "string" || name.length === 0)
    throw new TypeError(`${description} name must be nonempty`);
  if (typeof indexedDB === "undefined" || !globalThis.navigator?.locks)
    throw new Error(`${description} requires IndexedDB and Web Locks`);

  const databaseName = `${prefix}:${name}`;
  let release!: () => void;
  let acquired!: () => void;
  let failed!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    acquired = resolve;
    failed = reject;
  });
  const lease = navigator.locks.request(databaseName, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(`${description} is already open`);
    await new Promise<void>((resolve) => {
      release = resolve;
      acquired();
    });
  });
  void lease.catch(failed);
  await ready;

  let database: IDBDatabase | undefined;
  let base: BlockDeviceStorage | undefined;
  try {
    const backing = await prepare();
    const readableBase = "storage" in backing ? backing.storage : undefined;
    base = readableBase;
    const image = "image" in backing ? backing.image : undefined;
    const capacity = "image" in backing ? backing.image.capacity : backing.capacity;
    const identityKey = image ? IDENTITY_KEY : CAPACITY_KEY;
    database = await openDatabase(databaseName, description, existingOnly);
    const db = database;
    const identityTransaction = existingOnly
      ? db.transaction("metadata")
      : db.transaction("metadata", "readwrite", { durability: "strict" });
    const identityDone = committed(identityTransaction);
    let identityError: string | undefined;
    const metadata = identityTransaction.objectStore("metadata");
    const identityRequest = metadata.get(identityKey);
    identityRequest.onsuccess = () => {
      const stored = identityRequest.result;
      if (stored === undefined) {
        if (existingOnly) identityError = `${description} does not exist`;
        else metadata.put(image ?? capacity, identityKey);
      } else if (
        image
          ? stored?.url !== image.url ||
            stored?.etag !== image.etag ||
            stored?.capacity !== capacity
          : stored !== capacity
      ) {
        identityError = `${description} ${image ? "image identity" : "capacity"} mismatch`;
      }
      if (identityError) identityTransaction.abort();
    };
    try {
      await identityDone;
    } catch (error) {
      if (identityError) throw new Error(identityError);
      throw error;
    }

    let stopped = false;
    let pending = Promise.resolve();
    let closing: Promise<void> | undefined;
    const assertOpen = () => {
      if (stopped) throw new Error(`${description} is stopped`);
    };
    const validate = (offset: number, length: number) => {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > capacity - offset
      )
        throw new RangeError(`${description} I/O lies outside the ${image ? "image" : "disk"}`);
    };
    const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
      if (stopped) return Promise.reject(new Error(`${description} is stopped`));
      const result = pending.then(() => {
        assertOpen();
        return operation();
      });
      pending = result.then(
        () => {},
        () => {},
      );
      return result;
    };

    const writeSectors = async (
      start: number,
      end: number,
      sector: (position: number) => Uint8Array | undefined,
    ) => {
      assertOpen();
      const transaction = db.transaction("sectors", "readwrite", { durability: "strict" });
      const done = committed(transaction);
      try {
        const store = transaction.objectStore("sectors");
        for (let position = start; position < end; position += SECTOR_BYTES) {
          const value = sector(position);
          const key = position / SECTOR_BYTES;
          if (value?.some((byte) => byte !== 0)) {
            // Structured cloning a view can copy its entire backing buffer.
            store.put(value.byteLength === value.buffer.byteLength ? value : value.slice(), key);
          } else if (image) {
            store.put(ZERO_SECTOR, key);
          } else {
            store.delete(key);
          }
        }
      } catch (error) {
        transaction.abort();
        await done.catch(() => {});
        throw error;
      }
      await done;
    };

    const readBytes = async (offset: number, length: number): Promise<Uint8Array> => {
      const result = new Uint8Array(length);
      if (length === 0) return result;
      const first = Math.floor(offset / SECTOR_BYTES);
      const last = Math.floor((offset + length - 1) / SECTOR_BYTES);
      const sectors = new Map<number, SectorValue>();
      const transaction = db.transaction("sectors", "readonly");
      const done = committed(transaction);
      const request = transaction.objectStore("sectors").openCursor(IDBKeyRange.bound(first, last));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const value = cursor.value;
        if (
          value !== ZERO_SECTOR &&
          (!(value instanceof Uint8Array) || value.byteLength !== SECTOR_BYTES)
        ) {
          transaction.abort();
          return;
        }
        sectors.set(Number(cursor.key), value);
        cursor.continue();
      };
      await done;
      let position = offset;
      const end = offset + length;
      while (position < end) {
        const sector = Math.floor(position / SECTOR_BYTES);
        const stored = sectors.get(sector);
        let next = Math.min(end, (sector + 1) * SECTOR_BYTES);
        if (stored !== undefined) {
          if (stored !== ZERO_SECTOR) {
            result.set(
              stored.subarray(position % SECTOR_BYTES, (position % SECTOR_BYTES) + next - position),
              position - offset,
            );
          }
        } else {
          while (next < end && !sectors.has(Math.floor(next / SECTOR_BYTES)))
            next = Math.min(end, next + SECTOR_BYTES);
          if (readableBase)
            await readableBase.read(position, result.subarray(position - offset, next - offset));
        }
        position = next;
      }
      return result;
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      readableBase?.stop?.();
    };
    const close = () => {
      if (!closing) {
        stop();
        closing = pending.then(async () => {
          db.close();
          release();
          await lease;
        });
      }
      return closing;
    };
    // A direct database upgrade/deletion cannot leave this object operating
    // with stale metadata. Drain accepted work and release our connection/lock.
    db.onversionchange = () => {
      void close();
    };
    return {
      capacity,
      read(offset, target) {
        return enqueue(async () => {
          validate(offset, target.byteLength);
          const bytes = await readBytes(offset, target.byteLength);
          assertOpen();
          target.set(bytes);
          return bytes.byteLength;
        });
      },
      write(offset, data) {
        assertOpen();
        validate(offset, data.byteLength);
        // Own the payload before queuing so callers cannot mutate pending I/O.
        const payload = new Uint8Array(data);
        return enqueue(async () => {
          if (payload.byteLength === 0) return 0;
          const payloadEnd = offset + payload.byteLength;
          const start = Math.floor(offset / SECTOR_BYTES) * SECTOR_BYTES;
          const end = Math.ceil(payloadEnd / SECTOR_BYTES) * SECTOR_BYTES;
          let bytes = payload;
          if (start !== offset || end !== payloadEnd) {
            bytes = new Uint8Array(end - start);
            if (start !== offset) bytes.set(await readBytes(start, SECTOR_BYTES));
            if (end !== payloadEnd && (end - SECTOR_BYTES !== start || start === offset))
              bytes.set(
                await readBytes(end - SECTOR_BYTES, SECTOR_BYTES),
                end - start - SECTOR_BYTES,
              );
            bytes.set(payload, offset - start);
          }
          await writeSectors(start, end, (position) =>
            bytes.subarray(position - start, position - start + SECTOR_BYTES),
          );
          return payload.byteLength;
        });
      },
      writeZeroes(offset, length) {
        assertOpen();
        validate(offset, length);
        return enqueue(async () => {
          if (length === 0) return;
          const zeroEnd = offset + length;
          const start = Math.floor(offset / SECTOR_BYTES) * SECTOR_BYTES;
          const end = Math.ceil(zeroEnd / SECTOR_BYTES) * SECTOR_BYTES;
          let first: Uint8Array | undefined;
          let last: Uint8Array | undefined;
          if (start !== offset) {
            first = await readBytes(start, SECTOR_BYTES);
            first.fill(0, offset - start, Math.min(zeroEnd - start, SECTOR_BYTES));
          }
          if (end !== zeroEnd && (end - SECTOR_BYTES !== start || !first)) {
            last = await readBytes(end - SECTOR_BYTES, SECTOR_BYTES);
            last.fill(
              0,
              Math.max(0, offset - (end - SECTOR_BYTES)),
              zeroEnd - (end - SECTOR_BYTES),
            );
          }
          await writeSectors(start, end, (position) => {
            if (position === start && first) return first;
            if (position === end - SECTOR_BYTES && last) return last;
          });
        });
      },
      discard(offset, length) {
        assertOpen();
        validate(offset, length);
        if (offset % SECTOR_BYTES || length % SECTOR_BYTES || length > MAX_DISCARD_BYTES)
          throw new RangeError(
            `${description} discard requires a sector-aligned range up to 1 MiB`,
          );
        return enqueue(async () => {
          if (length) await writeSectors(offset, offset + length, () => undefined);
        });
      },
      flush() {
        return enqueue(async () => {});
      },
      stop,
      close,
    };
  } catch (error) {
    base?.stop?.();
    database?.close();
    release();
    await lease;
    throw error;
  }
}
