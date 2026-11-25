// SPDX-License-Identifier: MIT
import { openHttpBlockStorage, type BlockDeviceStorage } from "@lowland/kernel";

export async function installHttpDiskStorage(
  url: string,
  install: (storage: BlockDeviceStorage) => void,
) {
  const storage = await openHttpBlockStorage(url);
  try {
    install(storage);
  } catch (error) {
    storage.stop?.();
    throw error;
  }
}
