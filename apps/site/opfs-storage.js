// SPDX-License-Identifier: MIT

// A replacement page may briefly overlap the old worker's exclusive lock.
// Retry only lock contention, with a bounded total backoff of 1270 ms.
export async function openOpfsAccessHandle(
  handle,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await handle.createSyncAccessHandle();
    } catch (error) {
      if (error?.name !== "NoModificationAllowedError" || attempt === 7) throw error;
      await delay(10 * 2 ** attempt);
    }
  }
}

// Takes ownership of an already-open synchronous OPFS access handle.
export function installOpfsStorage(access, requestedCapacity, install) {
  try {
    if (requestedCapacity !== undefined) {
      if (
        !Number.isSafeInteger(requestedCapacity) ||
        requestedCapacity < 0 ||
        requestedCapacity % 512 !== 0
      ) {
        throw new RangeError("block capacity must be a nonnegative safe integer multiple of 512");
      }
      access.truncate(requestedCapacity);
    }
    const capacity = access.getSize();
    install({
      capacity,
      read(offset, target) {
        let read = 0;
        while (read < target.byteLength) {
          const n = access.read(target.subarray(read), { at: offset + read });
          if (n === 0) break;
          read += n;
        }
        return read;
      },
      write(offset, data) {
        let written = 0;
        while (written < data.byteLength) {
          const n = access.write(data.subarray(written), { at: offset + written });
          if (n === 0) break;
          written += n;
        }
        return written;
      },
      flush() {
        access.flush();
      },
      close() {
        try {
          access.flush();
        } catch (error) {
          // Preserve the failed durability operation even if releasing the
          // handle fails too. Always attempt to release the exclusive lock.
          try {
            access.close();
          } catch {}
          throw error;
        }
        access.close();
      },
    });
  } catch (error) {
    // Initialization never transferred ownership successfully. Preserve its
    // original failure even if releasing the exclusive lock also fails.
    try {
      access.close();
    } catch {}
    throw error;
  }
}
