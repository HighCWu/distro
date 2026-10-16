// SPDX-License-Identifier: MIT

/** Round-robin cursor; the caller owns occupancy checks for its flow tuple. */
export function createPortAllocator() {
  const first = 49152;
  const last = 65535;
  let next = first;
  return (inUse: (port: number) => boolean): number => {
    for (let attempts = 0; attempts < last - first + 1; attempts++) {
      const port = next;
      next = port === last ? first : port + 1;
      if (!inUse(port)) return port;
    }
    throw new Error("no network ports available");
  };
}
