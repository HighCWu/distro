// SPDX-License-Identifier: MIT
import { bootMachine, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

const bootRuntime = (initramfsPath) =>
  runRuntimeSmoke({
    bootMachine,
    consoleDevice,
    entropyDevice,
    async loadInitramfs() {
      const response = await fetch(initramfsPath);
      if (!response.ok) throw new Error(`runtime initramfs load failed: ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });

globalThis.bootRuntimeSmoke = () => bootRuntime("/runtime.cpio");
globalThis.bootCxxRuntimeSmoke = () => bootRuntime("/runtime-cxx.cpio");
globalThis.bootSqliteRuntimeSmoke = () => bootRuntime("/runtime-sqlite.cpio");
globalThis.bootSocketRuntimeSmoke = () => bootRuntime("/runtime-sockets.cpio");
