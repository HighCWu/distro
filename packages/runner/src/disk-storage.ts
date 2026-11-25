// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import type { BlockDeviceStorage } from "@lowland/kernel";

const zeroChunk = new Uint8Array(64 * 1024);

interface DiskFileOperations {
  openSync(path: string, flags: string): number;
  fstatSync(file: number): { size: number };
  readSync(
    file: number,
    target: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  writeSync(
    file: number,
    data: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;
  fsyncSync(file: number): void;
  closeSync(file: number): void;
}

/** Transfers ownership of an opened disk file only after device installation succeeds. */
export function installDiskStorage(
  path: string,
  install: (storage: BlockDeviceStorage) => void,
  operations: DiskFileOperations = fs,
) {
  let readonly = false;
  let file: number;
  try {
    file = operations.openSync(path, "r+");
  } catch {
    readonly = true;
    file = operations.openSync(path, "r");
  }
  try {
    const { size: capacity } = operations.fstatSync(file);
    function write(offset: number, data: Uint8Array, length = data.byteLength) {
      let written = 0;
      while (written < length) {
        const n = operations.writeSync(file, data, written, length - written, offset + written);
        if (n <= 0) break;
        written += n;
      }
      return written;
    }

    install({
      capacity,
      read(offset, target) {
        let read = 0;
        while (read < target.byteLength) {
          const n = operations.readSync(
            file,
            target,
            read,
            target.byteLength - read,
            offset + read,
          );
          if (n === 0) break;
          read += n;
        }
        return read;
      },
      write: readonly ? undefined : (offset, data) => write(offset, data),
      writeZeroes: readonly
        ? undefined
        : (offset, length) => {
            if (
              !Number.isSafeInteger(offset) ||
              !Number.isSafeInteger(length) ||
              offset < 0 ||
              length < 0 ||
              length > capacity - offset
            ) {
              throw new RangeError("disk zero range exceeds capacity");
            }
            while (length > 0) {
              const chunkLength = Math.min(length, zeroChunk.byteLength);
              if (write(offset, zeroChunk, chunkLength) !== chunkLength)
                throw new Error("could not write the complete disk zero range");
              offset += chunkLength;
              length -= chunkLength;
            }
          },
      flush: readonly ? undefined : () => operations.fsyncSync(file),
      close() {
        let failure: unknown;
        let failed = false;
        try {
          if (!readonly) operations.fsyncSync(file);
        } catch (error) {
          failed = true;
          failure = error;
        }
        try {
          operations.closeSync(file);
        } catch (error) {
          if (!failed) throw error;
        }
        if (failed) throw failure;
      },
    });
  } catch (error) {
    // Initialization has not transferred ownership. Preserve its failure even
    // if releasing the file descriptor also fails.
    try {
      operations.closeSync(file);
    } catch {}
    throw error;
  }
}
