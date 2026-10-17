// SPDX-License-Identifier: MIT
export const maximumDownloadBytes = 16 * 1024 * 1024;

// This deliberately buffers a bounded file, not an unbounded response stream.
// fstat checks the opened identity; concurrent writers are not snapshot-isolated.
export async function prepareDownload(fs, path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
    throw new TypeError("enter an absolute Linux file path without NUL");
  const check = (info) => {
    if (!info.isFile) throw new TypeError("download requires a regular file");
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > maximumDownloadBytes)
      throw new RangeError("download is limited to 16 MiB");
  };
  // Reject ordinary device/directory/FIFO selections before attempting open.
  // This is not a security boundary against another program replacing paths.
  check(await fs.stat(path));
  const file = await fs.open(path);
  let failure;
  let failed = false;
  let blob;
  try {
    check(await file.stat());
    const parts = [];
    const buffer = new Uint8Array(32768);
    let total = 0;
    for (;;) {
      const count = await file.read(buffer);
      if (count === null) break;
      if (!Number.isInteger(count) || count <= 0 || count > buffer.length)
        throw new Error("invalid file read length");
      total += count;
      if (total > maximumDownloadBytes) throw new RangeError("download is limited to 16 MiB");
      parts.push(buffer.slice(0, count));
    }
    blob = new Blob(parts, { type: "application/octet-stream" });
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await file.close();
  } catch (error) {
    if (failed)
      throw new AggregateError([failure, error], "download and close failed", { cause: failure });
    throw error;
  }
  if (failed) throw failure;
  return { blob, name: path.split("/").at(-1) || "download.bin" };
}
