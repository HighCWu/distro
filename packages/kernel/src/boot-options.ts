// SPDX-License-Identifier: MIT

// /chosen/ncpus is a single unsigned 32-bit device-tree cell. The kernel
// independently caps a valid request at its configured NR_CPUS limit.
export function checked_cpu_count(cpus: number): number {
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 0xffffffff) {
    throw new RangeError("cpus must be an integer between 1 and 4294967295");
  }
  return cpus;
}
