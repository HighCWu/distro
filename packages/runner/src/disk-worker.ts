// SPDX-License-Identifier: MIT

import { blockDevice, serveDevice } from "@lowland/kernel";
import { parentPort, workerData } from "node:worker_threads";
import { installDiskStorage } from "./disk-storage.ts";

if (!parentPort) throw new Error("disk worker requires a parent port");

const endpoint = parentPort;
installDiskStorage(workerData.path, (storage) => serveDevice(endpoint, blockDevice(storage)));
