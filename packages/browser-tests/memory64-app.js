// SPDX-License-Identifier: MIT
import { bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

globalThis.bootRuntimeSmoke = () =>
  runRuntimeSmoke({
    bootMachine,
    consoleDevice,
    entropyDevice,
    async loadInitramfs() {
      const response = await fetch("/runtime.cpio");
      if (!response.ok) throw new Error(`runtime initramfs load failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
