// SPDX-License-Identifier: MIT

import { blockDevice, type BlockDeviceStorage } from "./virtio/block.ts";
import type { VirtioDevice } from "./virtio/core.ts";

const copy_bytes = Uint8Array.prototype.set;
const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const snapshot_devices = new WeakSet<VirtioDevice>();

/** Experimental in-memory image backing, not a kernel file-mmap admission token.
 * Copies the input once; requires a sector-aligned image and a bounded allocation.
 * The source must not be shared with concurrently writing agents while copying.
 * This protects against ordinary source/target mutation, not a malicious host.
 */
export function snapshot_block_storage(
  image: Uint8Array,
  maximum_bytes = DEFAULT_MAXIMUM_BYTES,
): BlockDeviceStorage {
  if (!Number.isSafeInteger(maximum_bytes) || maximum_bytes < 0)
    throw new RangeError("invalid image snapshot limit");
  if (typeof SharedArrayBuffer !== "undefined" && image.buffer instanceof SharedArrayBuffer)
    throw new TypeError("image snapshot requires a non-shared source");
  const capacity = image.byteLength;
  if (capacity % 512 || capacity > maximum_bytes)
    throw new RangeError("image snapshot must be sector-aligned and fit its limit");
  // Unlike Buffer.slice(), this constructor copies even a Node Buffer input.
  let bytes: Uint8Array | null = new Uint8Array(image);
  return Object.freeze({
    capacity,
    read(offset: number, target: Uint8Array): number {
      if (!bytes) throw new Error("image snapshot is closed");
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new RangeError("invalid image snapshot offset");
      const count = Math.min(target.byteLength, Math.max(0, capacity - offset));
      // Do not pass a private view to an overridable target.set() callback.
      copy_bytes.call(target, bytes.subarray(offset, offset + count));
      return count;
    },
    close(): void {
      bytes = null;
    },
  });
}

/** Internal factory: provenance belongs to this exact local device object.
 * Generic block devices and remote proxies do not inherit it from their config.
 */
export function snapshot_block_device(
  image: Uint8Array,
  maximum_bytes = DEFAULT_MAXIMUM_BYTES,
): VirtioDevice {
  const storage = snapshot_block_storage(image, maximum_bytes);
  const device = blockDevice(
    Object.freeze({
      capacity: storage.capacity,
      read: storage.read,
      close() {
        snapshot_devices.delete(device);
        return storage.close?.();
      },
    }),
  );
  snapshot_devices.add(device);
  return device;
}

/** Versioned boot provenance, not a generic read-only flag or mmap permission.
 * Remains private to trusted host construction; it is not a malicious-host boundary.
 * A device must still be live, and its kernel filesystem must be separately checked.
 */
export function snapshot_device_tree_properties(device: VirtioDevice): Record<string, number> {
  return snapshot_devices.has(device) ? { "lowland,snapshot-image-v1": 1 } : {};
}
