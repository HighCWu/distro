// SPDX-License-Identifier: MIT

import { blockDevice, serveDevice, type BlockDeviceStorage } from "@lowland/kernel";
import { parentPort, workerData } from "node:worker_threads";
import { installDiskStorage } from "./disk-storage.ts";
import { installHttpDiskStorage } from "./http-disk-storage.ts";

if (!parentPort) throw new Error("disk worker requires a parent port");

const endpoint = parentPort;
const path: string = workerData.path;
const install = (storage: BlockDeviceStorage) => serveDevice(endpoint, blockDevice(storage));
if (/^https?:\/\//i.test(path)) {
  await installHttpDiskStorage(path, install);
} else {
  installDiskStorage(path, install);
}
