// SPDX-License-Identifier: MIT
import * as fs from "node:fs";
import type { BlockDeviceStorage } from "@lowland/kernel";

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
      write: readonly
        ? undefined
        : (offset, data) => {
            let written = 0;
            while (written < data.byteLength) {
              const n = operations.writeSync(
                file,
                data,
                written,
                data.byteLength - written,
                offset + written,
              );
              if (n === 0) break;
              written += n;
            }
            return written;
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
