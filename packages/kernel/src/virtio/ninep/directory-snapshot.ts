// SPDX-License-Identifier: MIT
import { MemoryFs } from "./memfs.ts";

interface SnapshotFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Structural subset: native directory iterators yield FileSystemHandle,
 * whose kind identifies which additional method must be checked at runtime. */
export interface NinepBrowserSnapshotEntry {
  readonly kind: "file" | "directory";
  entries?(): AsyncIterable<[string, NinepBrowserSnapshotEntry]>;
  getFile?(): Promise<SnapshotFile>;
}

export interface NinepBrowserSnapshotDirectory {
  entries(): AsyncIterable<[string, NinepBrowserSnapshotEntry]>;
}

export interface NinepBrowserSnapshotLimits {
  /** Maximum summed file payload bytes; files are copied sequentially. */
  maxBytes: number;
  /** Maximum files plus directories, including the root directory. */
  maxEntries: number;
}

/** Import a bounded, independent directory snapshot for serveNinep. This only
 * reads the user-selected handles; writes to the returned MemoryFs never reach
 * the browser directory. Capture files and check all quotas before reading any
 * payload. Copying may temporarily retain one additional source-file buffer.
 * A changing source directory is not a filesystem-wide atomic snapshot.
 */
export async function importNinepBrowserDirectorySnapshot(
  root: NinepBrowserSnapshotDirectory,
  { maxBytes, maxEntries }: NinepBrowserSnapshotLimits,
): Promise<MemoryFs> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(maxEntries) ||
    maxEntries <= 0
  )
    throw new RangeError("directory snapshot limits must be positive safe integers");
  if (!root || typeof root.entries !== "function")
    throw new TypeError("directory snapshot requires an entries iterator");

  const encoder = new TextEncoder();
  const paths = new Set<string>();
  const files: { path: string; file: SnapshotFile; size: number }[] = [];
  const fs = new MemoryFs();
  let entries = 1,
    bytes = 0;
  const visit = async (directory: NinepBrowserSnapshotDirectory, parent: string): Promise<void> => {
    for await (const [name, handle] of directory.entries()) {
      if (
        typeof name !== "string" ||
        !name ||
        name.length > 255 ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\0") ||
        !name.isWellFormed() ||
        encoder.encode(name).length > 255
      )
        throw new TypeError("directory snapshot contains an invalid Linux filename");
      const path = `${parent}/${name}`;
      if (paths.has(path)) throw new TypeError("directory snapshot contains a duplicate entry");
      if (entries >= maxEntries) throw new RangeError("directory snapshot entry limit exceeded");
      paths.add(path);
      entries++;
      if (handle?.kind === "directory" && typeof handle.entries === "function") {
        fs.mkdirp(path);
        await visit({ entries: () => handle.entries!() }, path);
      } else if (handle?.kind === "file" && typeof handle.getFile === "function") {
        const file = await handle.getFile();
        const size = file?.size;
        if (
          !file ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          typeof file.arrayBuffer !== "function"
        )
          throw new TypeError("directory snapshot file metadata is invalid");
        if (size > maxBytes - bytes) throw new RangeError("directory snapshot byte limit exceeded");
        bytes += size;
        files.push({ path, file, size });
      } else {
        throw new TypeError("directory snapshot entry has an unsupported handle");
      }
    }
  };
  await visit(root, "");
  for (const { path, file, size } of files) {
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength !== size)
      throw new Error("directory snapshot file payload does not match captured size");
    fs.writeFile(path, new Uint8Array(buffer));
  }
  return fs;
}
