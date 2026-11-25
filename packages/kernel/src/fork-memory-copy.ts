// SPDX-License-Identifier: MIT

const copyChunkSize = 0x10000;

function containsNonzeroByte(bytes: Uint8Array): boolean {
  const prefix = Math.min((4 - (bytes.byteOffset % 4)) % 4, bytes.byteLength);
  for (let index = 0; index < prefix; index++) {
    if (bytes[index] !== 0) return true;
  }
  if (prefix === bytes.byteLength) return false;
  const words = new Uint32Array(
    bytes.buffer,
    bytes.byteOffset + prefix,
    Math.floor((bytes.byteLength - prefix) / 4),
  );
  for (let index = 0; index < words.length; index++) {
    if (words[index] !== 0) return true;
  }
  for (let index = prefix + words.byteLength; index < bytes.byteLength; index++) {
    if (bytes[index] !== 0) return true;
  }
  return false;
}

/** Copy an immutable fork snapshot into a distinct, freshly zeroed target.
 * Both views must have equal lengths. The caller owns source immutability and
 * the fresh-zero target precondition for the duration of this synchronous copy.
 * All-zero chunks retain the target's existing zero backing without writes.
 */
export function copy_fork_memory_to_fresh_target(
  source: Uint8Array,
  destination: Uint8Array,
): void {
  if (source.byteLength !== destination.byteLength)
    throw new RangeError("fork memory copy views must have equal lengths");
  for (let offset = 0; offset < source.byteLength; offset += copyChunkSize) {
    const bytes = source.subarray(offset, Math.min(offset + copyChunkSize, source.byteLength));
    if (containsNonzeroByte(bytes)) destination.set(bytes, offset);
  }
}
