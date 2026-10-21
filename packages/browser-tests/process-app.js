// SPDX-License-Identifier: MIT
import { bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

globalThis.bootProcessRuntimeSmoke = () => {
  if (!crossOriginIsolated) throw new Error("process runtime requires cross-origin isolation");
  return runRuntimeSmoke({
    bootMachine,
    consoleDevice,
    entropyDevice,
    async loadInitramfs() {
      const response = await fetch("/runtime.cpio");
      if (!response.ok) throw new Error(`process initramfs load failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
};
