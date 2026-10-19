// SPDX-License-Identifier: MIT
import * as normal from "@lowland/kernel";
import * as faults from "./node_modules/@lowland/kernel-faults/dist/index.js";
import * as signals from "./node_modules/@lowland/kernel-signals/dist/index.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";

const profiles = {
  normal: { loader: normal, initramfs: "/runtime.cpio" },
  faults: { loader: faults, initramfs: "/faults.cpio" },
  signals: { loader: signals, initramfs: "/signals.cpio" },
};

globalThis.bootForkRuntimeSmoke = (mode = "normal") => {
  if (!Object.hasOwn(profiles, mode)) throw new Error("unknown fork test mode");
  const { loader, initramfs } = profiles[mode];
  const { bootMachine, consoleDevice, entropyDevice } = loader;
  if (!crossOriginIsolated) throw new Error("fork browser check requires cross-origin isolation");
  return runRuntimeSmoke({
    bootMachine,
    consoleDevice,
    entropyDevice,
    onProgress(message) {
      console.log(`fork progress: ${mode}: ${message}`);
    },
    async loadInitramfs() {
      const response = await fetch(initramfs);
      if (!response.ok) throw new Error(`fork initramfs load failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
};
