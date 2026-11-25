// SPDX-License-Identifier: MIT

import { Struct, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import { VirtioController, type VirtioDevice, type Virtqueue } from "./core.ts";

const BlockDeviceFeatures = {
  RO: 1n << 5n,
  FLUSH: 1n << 9n,
  DISCARD: 1n << 13n,
  WRITE_ZEROES: 1n << 14n,
} as const;

class BlockDeviceConfig extends Struct({ capacity: U64LE }) {}

class BlockDeviceRequest extends Struct({
  type: U32LE,
  reserved: U32LE,
  sector: U64LE,
}) {}

class BlockDeviceRange extends Struct({
  sector: U64LE,
  numSectors: U32LE,
  flags: U32LE,
}) {}

// One request consumes at most 1 MiB of backend work, with no payload-sized
// allocation. Linux splits larger discard/zeroout operations using this limit.
const maxRangeSectors = 2048;
const writeZeroesUnmapFlag = 1;
const writeZeroesConfig = {
  size: 60,
  maxSectorsOffset: 48,
  maxSegmentsOffset: 52,
} as const;
const discardConfig = {
  size: 48,
  maxSectorsOffset: 36,
  maxSegmentsOffset: 40,
  alignmentOffset: 44,
} as const;

const BlockDeviceRequestType = {
  IN: 0,
  OUT: 1,
  FLUSH: 4,
  GET_ID: 8,
  DISCARD: 11,
  WRITE_ZEROES: 13,
} as const;

const BlockDeviceStatus = {
  OK: 0,
  IOERR: 1,
  UNSUPP: 2,
} as const;

type MaybePromise<T> = T | Promise<T>;

/**
 * The storage behind a block device. Read, write, zero, discard and flush exceptions/rejections
 * complete the affected request with IOERR; already performed I/O is not undone.
 * Close failures still propagate to the machine's shutdown result.
 */
export interface BlockDeviceStorage {
  /** Reads into `target` at `offset`, returning the bytes read. */
  read(offset: number, target: Uint8Array): MaybePromise<number>;
  /** Writes `data` at `offset`, returning the bytes written. Without it the device is read-only. */
  write?(offset: number, data: Uint8Array): MaybePromise<number>;
  /** Zeroes exactly `length` existing bytes at `offset`, retaining capacity.
   * Requires write capability. Successful reads must return zeroes for the
   * entire range. Exceptions/rejections report IOERR; partial I/O is not undone.
   */
  writeZeroes?(offset: number, length: number): MaybePromise<void>;
  /** Discards exactly `length` existing bytes at `offset`, retaining capacity.
   * Requires write capability. Subsequent contents are unspecified; storage
   * must still support reads and writes of the discarded range. Exceptions or
   * rejections report IOERR; partial I/O is not undone.
   */
  discard?(offset: number, length: number): MaybePromise<void>;
  /** Flushes completed writes. Its presence advertises the flush feature. */
  flush?(): MaybePromise<void>;
  /** Releases storage resources when the device closes. */
  close?(): MaybePromise<void>;
  /** Synchronously starts cancellation when the device closes, before waiting
   * for in-flight I/O. Must arrange for pending operations to settle; it must
   * not release resources still used by them. Final disposal belongs in close.
   * Optional: existing storage without it is still drained before close.
   */
  stop?(): void;
  /** Total bytes: a nonnegative safe integer multiple of 512, snapshotted at creation. */
  capacity: number;
  /** Stable 1–20 printable ASCII identifier, snapshotted at creation. */
  readonly serial?: string;
}

/**
 * A virtio block device backed by a storage object.
 *
 * @example Serve a read-only root filesystem image
 * ```ts
 * blockDevice({
 *   capacity: rootfs.byteLength,
 *   read(offset, target) {
 *     const source = rootfs.subarray(offset, offset + target.byteLength);
 *     target.set(source);
 *     return source.byteLength;
 *   },
 * })
 * ```
 */
export function blockDevice(storage: BlockDeviceStorage): VirtioDevice {
  const capacity = storage.capacity;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity % 512 !== 0) {
    throw new RangeError("block capacity must be a nonnegative safe integer multiple of 512");
  }
  const serial = storage.serial;
  let identity: Uint8Array | undefined;
  if (serial !== undefined) {
    if (
      typeof serial !== "string" ||
      serial.length < 1 ||
      serial.length > 20 ||
      /[^\x20-\x7e]/.test(serial)
    )
      throw new RangeError("block serial must contain 1–20 printable ASCII bytes");
    identity = new Uint8Array(20);
    identity.set(new TextEncoder().encode(serial));
  }
  const writeZeroes = storage.write ? storage.writeZeroes?.bind(storage) : undefined;
  const discard = storage.write ? storage.discard?.bind(storage) : undefined;
  const config = new Uint8Array(
    writeZeroes ? writeZeroesConfig.size : discard ? discardConfig.size : BlockDeviceConfig.size,
  );
  new BlockDeviceConfig(config).capacity = BigInt(capacity / 512);
  let features = 0n;
  if (storage.flush) features |= BlockDeviceFeatures.FLUSH;
  if (!storage.write) features |= BlockDeviceFeatures.RO;
  if (writeZeroes) {
    features |= BlockDeviceFeatures.WRITE_ZEROES;
    // virtio_blk_config keeps its standard packed layout even when preceding
    // optional features are absent. may_unmap remains clear.
    const view = new DataView(config.buffer);
    view.setUint32(writeZeroesConfig.maxSectorsOffset, maxRangeSectors, true);
    view.setUint32(writeZeroesConfig.maxSegmentsOffset, 1, true);
  }
  if (discard) {
    features |= BlockDeviceFeatures.DISCARD;
    const view = new DataView(config.buffer);
    view.setUint32(discardConfig.maxSectorsOffset, maxRangeSectors, true);
    view.setUint32(discardConfig.maxSegmentsOffset, 1, true);
    view.setUint32(discardConfig.alignmentOffset, 1, true);
  }
  let stopping = false;

  async function notify(queue: Virtqueue) {
    for (const chain of queue) {
      if (stopping) return;
      const descs = [...chain];
      const header = descs[0];
      const status = descs[descs.length - 1];
      const data = descs.slice(1, -1);

      assert(header && !header.writable, "header must be readonly");
      assert(
        header.array.byteLength === BlockDeviceRequest.size,
        `header size is ${header.array.byteLength}`,
      );
      assert(status && status.writable, "status must be writable");
      assert(status.array.byteLength === 1, `status size is ${status.array.byteLength}`);
      const status_desc = status;

      const request = new BlockDeviceRequest(header.array);

      function set_status(value: number) {
        status_desc.array[0] = value;
      }

      let n = 0;
      const byteOffset = request.sector * 512n;
      if (
        request.type === BlockDeviceRequestType.IN ||
        request.type === BlockDeviceRequestType.OUT
      ) {
        const length = data.reduce((sum, desc) => sum + BigInt(desc.array.byteLength), 0n);
        if (byteOffset + length > BigInt(capacity)) {
          set_status(BlockDeviceStatus.IOERR);
          chain.release(1);
          continue;
        }
      }
      // Read/write offsets are exact only after the full BigInt range check.
      let offset = Number(byteOffset);
      switch (request.type) {
        case BlockDeviceRequestType.IN: {
          let ok = true;
          for (const desc of data) {
            assert(desc.writable, "data must be writable when IN");
            let read: number;
            try {
              read = await storage.read(offset, desc.array);
            } catch {
              ok = false;
              break;
            }
            if (stopping) return;
            if (read !== desc.array.byteLength) {
              ok = false;
              break;
            }
            n += read;
            offset += read;
          }
          set_status(ok ? BlockDeviceStatus.OK : BlockDeviceStatus.IOERR);
          break;
        }
        case BlockDeviceRequestType.OUT: {
          if (!storage.write) {
            set_status(BlockDeviceStatus.UNSUPP);
            break;
          }
          let ok = true;
          for (const desc of data) {
            assert(!desc.writable, "data must be readonly when OUT");
            let written: number;
            try {
              written = await storage.write(offset, desc.array);
            } catch {
              ok = false;
              break;
            }
            if (stopping) return;
            if (written !== desc.array.byteLength) {
              ok = false;
              break;
            }
            offset += written;
          }
          set_status(ok ? BlockDeviceStatus.OK : BlockDeviceStatus.IOERR);
          break;
        }
        case BlockDeviceRequestType.FLUSH: {
          if (!storage.flush) {
            set_status(BlockDeviceStatus.UNSUPP);
            break;
          }
          try {
            await storage.flush();
            set_status(BlockDeviceStatus.OK);
          } catch {
            set_status(BlockDeviceStatus.IOERR);
          }
          break;
        }
        case BlockDeviceRequestType.DISCARD:
        case BlockDeviceRequestType.WRITE_ZEROES: {
          const operation = request.type === BlockDeviceRequestType.DISCARD ? discard : writeZeroes;
          if (!operation) {
            set_status(storage.write ? BlockDeviceStatus.UNSUPP : BlockDeviceStatus.IOERR);
            break;
          }
          const length = data.reduce((sum, desc) => sum + BigInt(desc.array.byteLength), 0n);
          if (length !== BigInt(BlockDeviceRange.size) || data.some((desc) => desc.writable)) {
            set_status(BlockDeviceStatus.IOERR);
            break;
          }
          const bytes = new Uint8Array(BlockDeviceRange.size);
          let position = 0;
          for (const desc of data) {
            bytes.set(desc.array, position);
            position += desc.array.byteLength;
          }
          const range = new BlockDeviceRange(bytes);
          // DISCARD reserves every flag. WRITE_ZEROES accepts the UNMAP hint
          // but its storage operation still guarantees zero-filled reads.
          const allowedFlags =
            request.type === BlockDeviceRequestType.DISCARD ? 0 : writeZeroesUnmapFlag;
          if (range.flags & ~allowedFlags) {
            set_status(BlockDeviceStatus.UNSUPP);
            break;
          }
          const start = range.sector * 512n;
          const size = BigInt(range.numSectors) * 512n;
          if (range.numSectors > maxRangeSectors || start + size > BigInt(capacity)) {
            set_status(BlockDeviceStatus.IOERR);
            break;
          }
          let ok = true;
          try {
            if (size) await operation(Number(start), Number(size));
          } catch {
            ok = false;
          }
          if (stopping) return;
          set_status(ok ? BlockDeviceStatus.OK : BlockDeviceStatus.IOERR);
          break;
        }
        case BlockDeviceRequestType.GET_ID: {
          if (!identity) {
            set_status(BlockDeviceStatus.UNSUPP);
            break;
          }
          const length = data.reduce((sum, desc) => sum + BigInt(desc.array.byteLength), 0n);
          if (data.some((desc) => !desc.writable) || length < BigInt(identity.byteLength)) {
            set_status(BlockDeviceStatus.IOERR);
            break;
          }
          for (const desc of data) {
            const size = Math.min(identity.byteLength - n, desc.array.byteLength);
            if (size) desc.array.set(identity.subarray(n, n + size));
            n += size;
          }
          set_status(BlockDeviceStatus.OK);
          break;
        }
        default:
          console.error("unknown request type", request.type);
          set_status(BlockDeviceStatus.UNSUPP);
      }

      // Only IN/GET_ID data and the status byte are device-written buffers. OUT
      // payload bytes are consumed by the device, not written back to Linux.
      if (stopping) return;
      chain.release(n + 1);
    }
  }

  return new VirtioController(
    { deviceId: 2, features, config },
    {
      queues: [notify],
      stop() {
        stopping = true;
        storage.stop?.();
      },
      close: () => storage.close?.(),
    },
  ).device;
}
