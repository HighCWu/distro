// SPDX-License-Identifier: MIT
import type { BlockDeviceStorage } from "@lowland/kernel";

const SECTOR_BYTES = 512;
const REQUEST_TIMEOUT_MS = 60_000;
const STRONG_ETAG = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/i;

interface HttpImage {
  url: string;
  capacity: number;
  etag: string;
}

async function readRange(
  url: string,
  offset: number,
  length: number,
  signal: AbortSignal,
  image?: HttpImage,
) {
  const last = offset + length - 1;
  const headers = new Headers({
    Range: `bytes=${offset}-${last}`,
    "Accept-Encoding": "identity",
  });
  if (image) headers.set("If-Range", image.etag);

  // Pin the final URL at discovery because validators are scoped to a resource.
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    redirect: image ? "error" : "follow",
  });
  const reader = response.body?.getReader();
  try {
    if (response.status !== 206) {
      throw new Error(`HTTP disk expected status 206, received ${response.status}`);
    }
    const etag = response.headers.get("ETag");
    if (!etag || !STRONG_ETAG.test(etag)) throw new Error("HTTP disk requires a strong ETag");
    if (image && etag !== image.etag) throw new Error("HTTP disk ETag changed");

    const range = CONTENT_RANGE.exec(response.headers.get("Content-Range") ?? "");
    const capacity = Number(range?.[3]);
    if (
      !range ||
      Number(range[1]) !== offset ||
      Number(range[2]) !== last ||
      !Number.isSafeInteger(capacity) ||
      capacity <= last ||
      capacity % SECTOR_BYTES !== 0
    ) {
      throw new Error("HTTP disk returned an invalid Content-Range");
    }
    if (image && capacity !== image.capacity) throw new Error("HTTP disk capacity changed");

    const encoding = response.headers.get("Content-Encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") {
      throw new Error("HTTP disk range uses unsupported Content-Encoding");
    }
    const contentLength = response.headers.get("Content-Length");
    if (
      contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) !== length)
    ) {
      throw new Error("HTTP disk returned an incorrect Content-Length");
    }
    if (!reader) throw new Error("HTTP disk range has no body");

    // Bound buffering by the requested range, including responses without
    // Content-Length. A failed response must not write into the caller's view.
    const bytes = new Uint8Array(length);
    let copied = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > length - copied) throw new Error("HTTP disk range body is too long");
      bytes.set(value, copied);
      copied += value.byteLength;
    }
    if (copied !== length) throw new Error("HTTP disk range body is too short");
    return { url: response.url, etag, capacity, bytes };
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Installs a read-only block image pinned by its URL, size and strong ETag. */
export async function installHttpDiskStorage(
  url: string,
  install: (storage: BlockDeviceStorage) => void,
) {
  const abort = new AbortController();
  const { signal } = abort;
  try {
    const { url: finalUrl, capacity, etag } = await readRange(url, 0, SECTOR_BYTES, signal);
    const image = { url: finalUrl, capacity, etag };
    install({
      capacity,
      async read(offset, target) {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(offset) || offset < 0 || target.byteLength > capacity - offset) {
          throw new RangeError("HTTP disk read lies outside the image");
        }
        if (target.byteLength === 0) return 0;
        const { bytes } = await readRange(image.url, offset, target.byteLength, signal, image);
        signal.throwIfAborted();
        target.set(bytes);
        return bytes.byteLength;
      },
      stop() {
        abort.abort();
      },
    });
  } catch (error) {
    abort.abort();
    throw error;
  }
}
