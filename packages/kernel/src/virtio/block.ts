// SPDX-License-Identifier: MIT

import { Struct, U32LE, U64LE } from "@lowland/bytes";
import { assert } from "../util.ts";
import { VirtioController, type VirtioDevice, type Virtqueue } from "./core.ts";

const BlockDeviceFeatures = {
  RO: 1n << 5n,
  FLUSH: 1n << 9n,
} as const;

class BlockDeviceConfig extends Struct({ capacity: U64LE }) {}

class BlockDeviceRequest extends Struct({
  type: U32LE,
  reserved: U32LE,
  sector: U64LE,
}) {}

const BlockDeviceRequestType = {
  IN: 0,
  OUT: 1,
  FLUSH: 4,
  GET_ID: 8,
} as const;

const BlockDeviceStatus = {
  OK: 0,
  IOERR: 1,
  UNSUPP: 2,
} as const;

type MaybePromise<T> = T | Promise<T>;

/**
 * The storage behind a block device. Read, write and flush exceptions/rejections
 * complete the affected request with IOERR; already performed I/O is not undone.
 * Close failures still propagate to the machine's shutdown result.
 */
export interface BlockDeviceStorage {
  /** Reads into `target` at `offset`, returning the bytes read. */
  read(offset: number, target: Uint8Array): MaybePromise<number>;
  /** Writes `data` at `offset`, returning the bytes written. Without it the device is read-only. */
  write?(offset: number, data: Uint8Array): MaybePromise<number>;
  /** Flushes completed writes. Its presence advertises the flush feature. */
  flush?(): MaybePromise<void>;
  /** Releases storage resources when the device closes. */
  close?(): MaybePromise<void>;
  /** Total bytes: a nonnegative safe integer multiple of 512, snapshotted at creation. */
  capacity: number;
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
  const config = new Uint8Array(BlockDeviceConfig.size);
  new BlockDeviceConfig(config).capacity = BigInt(capacity / 512);
  let features = 0n;
  if (storage.flush) features |= BlockDeviceFeatures.FLUSH;
  if (!storage.write) features |= BlockDeviceFeatures.RO;

  async function notify(queue: Virtqueue) {
    for (const chain of queue) {
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
        case BlockDeviceRequestType.GET_ID: {
          // No stable device identifier is supplied by the storage interface.
          // Do not report success with an untouched caller-owned ID buffer.
          set_status(BlockDeviceStatus.UNSUPP);
          break;
        }
        default:
          console.error("unknown request type", request.type);
          set_status(BlockDeviceStatus.UNSUPP);
      }

      // Only IN data and the status byte are device-written buffers. OUT
      // payload bytes are consumed by the device, not written back to Linux.
      chain.release(n + 1);
    }
  }

  return new VirtioController(
    { deviceId: 2, features, config },
    { queues: [notify], close: () => storage.close?.() },
  ).device;
}
