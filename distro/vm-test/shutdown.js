// SPDX-License-Identifier: MIT
import { closeSync } from "node:fs";

/** Keep caller-owned disk handles alive until device I/O and Workers settle.
 * A pending shutdown is bounded by the runner's external watchdog, not by
 * closing storage resources while they may still be in use.
 */
export async function closeTestResources(machine, disks, closeDisk = closeSync) {
  let failed = false;
  let failure;
  const remember = (error) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };
  if (machine) {
    try {
      machine.close();
    } catch (error) {
      remember(error);
    }
    try {
      await machine.closed;
    } catch (error) {
      remember(error);
    }
  }
  for (const disk of disks) {
    try {
      closeDisk(disk);
    } catch (error) {
      remember(error);
    }
  }
  if (failed) throw failure;
}
