// SPDX-License-Identifier: MIT
import * as normal from "@lowland/kernel";
import * as faults from "./node_modules/@lowland/kernel-faults/dist/index.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";

globalThis.bootForkRuntimeSmoke = (mode = "normal") => {
  if (mode !== "normal" && mode !== "faults") throw new Error("unknown fork test mode");
  const { bootMachine, consoleDevice, entropyDevice } = mode === "faults" ? faults : normal;
  if (!crossOriginIsolated) throw new Error("fork browser check requires cross-origin isolation");
  return runRuntimeSmoke({
    bootMachine,
    consoleDevice,
    entropyDevice,
    onProgress(message) {
      console.log(`fork progress: ${mode}: ${message}`);
    },
    async loadInitramfs() {
      const response = await fetch(mode === "faults" ? "/faults.cpio" : "/runtime.cpio");
      if (!response.ok) throw new Error(`fork initramfs load failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
};
