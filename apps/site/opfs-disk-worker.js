// SPDX-License-Identifier: MIT

import { blockDevice } from "@lowland/kernel/virtio/block.js";
import { serveDevice } from "@lowland/kernel/virtio/remote.js";
import { installOpfsStorage } from "./opfs-storage.js";

const configuration = await new Promise((resolve) =>
  addEventListener("message", (event) => resolve(event.data), { once: true }),
);

async function openAccessHandle(handle) {
  // A navigation may start the replacement worker while the old page's worker
  // is still releasing its exclusive OPFS lock. Retry only that lock conflict;
  // every other initialization error must remain visible to workerDevice().
  for (let attempt = 0; ; attempt++) {
    try {
      return await handle.createSyncAccessHandle();
    } catch (error) {
      if (error?.name !== "NoModificationAllowedError" || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

const access = await openAccessHandle(configuration.handle);
installOpfsStorage(access, configuration.capacity, (storage) => {
  serveDevice(self, blockDevice(storage));
});
