// SPDX-License-Identifier: MIT
import { bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

globalThis.bootProcessRuntimeSmoke = async () => {
  if (!crossOriginIsolated) throw new Error("process runtime requires cross-origin isolation");
  const response = await fetch("/profile.json");
  if (!response.ok) throw new Error(`process profile load failed: ${response.status}`);
  const { cpus = 2 } = await response.json();
  if (cpus !== 1 && cpus !== 2) throw new Error("invalid process CPU profile");
  return runRuntimeSmoke({
    cpus,
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
