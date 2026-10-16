// SPDX-License-Identifier: MIT

import { blockDevice } from "@lowland/kernel/virtio/block.js";
import { serveDevice } from "@lowland/kernel/virtio/remote.js";
import { installOpfsStorage, openOpfsAccessHandle } from "./opfs-storage.js";

const configuration = await new Promise((resolve) =>
  addEventListener("message", (event) => resolve(event.data), { once: true }),
);

const access = await openOpfsAccessHandle(configuration.handle);
installOpfsStorage(access, configuration.capacity, (storage) => {
  serveDevice(self, blockDevice(storage));
});
