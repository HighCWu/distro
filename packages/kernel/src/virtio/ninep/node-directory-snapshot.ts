// SPDX-License-Identifier: MIT
/// <reference types="node" />

import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { MemoryFs } from "./memfs.ts";

export interface NinepDirectorySnapshotLimits {
  /** Maximum total regular-file and symlink-text bytes. */
  maxBytes: number;
  /** Maximum inode entries, including directories and the root. */
  maxEntries: number;
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// Linux asm-generic/x86 UAPI; Node does not expose O_PATH. Admission below
// restricts this Node-only helper to x86-64 and AArch64 hosts.
const O_PATH = 0x200000;
const decode = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const anchored = (directory: FileHandle, name = "") =>
  `/proc/self/fd/${directory.fd}${name ? `/${name}` : ""}`;

function component(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\0"))
    throw failure("EINVAL", "invalid snapshot path component");
}

function sameIdentity(expected: BigIntStats, actual: BigIntStats): void {
  if (
    expected.dev !== actual.dev ||
    expected.ino !== actual.ino ||
    (expected.mode & 0o170000n) !== (actual.mode & 0o170000n)
  )
    throw failure("ESTALE", "snapshot entry changed during import");
}

async function withClosed<T>(
  resource: { close(): Promise<void> },
  action: () => Promise<T>,
): Promise<T> {
  let succeeded = false;
  try {
    const result = await action();
    succeeded = true;
    return result;
  } finally {
    try {
      await resource.close();
    } catch (error) {
      if (succeeded) throw error;
    }
  }
}

async function openRoot(root: string): Promise<FileHandle> {
  if (!root || root.includes("\0") || !root.isWellFormed())
    throw failure("EINVAL", "invalid snapshot root");
  let directory = await open("/", directoryFlags);
  try {
    for (const name of path.resolve(root).split("/").filter(Boolean)) {
      component(name);
      const next = await open(anchored(directory, name), directoryFlags);
      const previous = directory;
      directory = next;
      await previous.close();
    }
    return directory;
  } catch (error) {
    try {
      await directory.close();
    } catch {}
    throw error;
  }
}

/** Node/Linux-only bounded copy; never a live host filesystem adapter.
 * Every descent is anchored to a held directory descriptor. Symlinks retain
 * their text for Linux namespace resolution and are never traversed on the host.
 * Concurrent host changes may fail the import; this is not an atomic tree view.
 */
export async function importNinepDirectorySnapshot(
  root: string,
  limits: NinepDirectorySnapshotLimits,
): Promise<MemoryFs> {
  for (const name of ["maxBytes", "maxEntries"] as const)
    if (!Number.isSafeInteger(limits[name]) || limits[name] <= 0)
      throw new RangeError(`${name} must be a positive safe integer`);
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
    throw failure("EOPNOTSUPP", "directory snapshots require x86-64/AArch64 Linux /proc/self/fd");
  const maxBytes = limits.maxBytes,
    maxEntries = limits.maxEntries;
  let bytes = 0,
    entries = 1;
  const fs = new MemoryFs();
  function reserve(length: bigint): number {
    if (length < 0n || length > BigInt(maxBytes - bytes))
      throw failure("E2BIG", "snapshot exceeds maxBytes");
    const result = Number(length);
    bytes += result;
    return result;
  }
  async function visit(directory: FileHandle, destination: string): Promise<void> {
    const stream = await opendir(anchored(directory), { encoding: "latin1" });
    await withClosed(stream, async () => {
      for (;;) {
        const entry = await stream.read();
        if (!entry) break;
        if (++entries > maxEntries) throw failure("E2BIG", "snapshot exceeds maxEntries");
        // Decode raw filename bytes strictly instead of selecting a different
        // host entry after a lossy replacement-character conversion.
        const name = decode.decode(Uint8Array.from(entry.name, (byte) => byte.charCodeAt(0)));
        component(name);
        const source = anchored(directory, name);
        const target = `${destination}/${name}`;
        const metadata = await lstat(source, { bigint: true });
        const mode = Number(metadata.mode & 0o777n);
        if (metadata.isSymbolicLink()) {
          // Linux bounds symlink text; still account it before retaining a copy.
          reserve(metadata.size);
          const text = await readlink(source, { encoding: "buffer" });
          sameIdentity(metadata, await lstat(source, { bigint: true }));
          if (BigInt(text.length) !== metadata.size)
            throw failure("ESTALE", "snapshot symlink changed during import");
          fs.symlink(target, decode.decode(text));
        } else if (metadata.isDirectory()) {
          const child = await open(source, directoryFlags);
          await withClosed(child, async () => {
            sameIdentity(metadata, await child.stat({ bigint: true }));
            fs.mkdir(target, mode);
            await visit(child, target);
          });
        } else if (metadata.isFile()) {
          const pin = await open(source, O_PATH | constants.O_NOFOLLOW);
          await withClosed(pin, async () => {
            const before = await pin.stat({ bigint: true });
            sameIdentity(metadata, before);
            if (!before.isFile())
              throw failure("ESTALE", "snapshot file type changed during import");
            const file = await open(anchored(pin), constants.O_RDONLY | constants.O_NONBLOCK);
            await withClosed(file, async () => {
              sameIdentity(before, await file.stat({ bigint: true }));
              const data = new Uint8Array(reserve(before.size));
              for (let offset = 0; offset < data.length;) {
                const { bytesRead } = await file.read(
                  data,
                  offset,
                  Math.min(65536, data.length - offset),
                  offset,
                );
                if (!bytesRead) throw failure("ESTALE", "snapshot file shrank during import");
                offset += bytesRead;
              }
              const after = await file.stat({ bigint: true });
              if (
                after.size !== before.size ||
                after.mtimeNs !== before.mtimeNs ||
                after.ctimeNs !== before.ctimeNs
              )
                throw failure("ESTALE", "snapshot file changed during import");
              fs.writeFile(target, data, { mode });
            });
          });
        } else {
          throw failure("EOPNOTSUPP", `unsupported snapshot file type: ${target}`);
        }
      }
    });
  }
  const directory = await openRoot(root);
  return withClosed(directory, async () => {
    fs.setattr("/", { mode: Number((await directory.stat({ bigint: true })).mode & 0o777n) });
    await visit(directory, "");
    return fs;
  });
}
