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
globalThis.bootTimeRuntimeSmoke = () => bootRuntime("/runtime-time.cpio");
globalThis.bootThreadTimeRuntimeSmoke = () => bootRuntime("/runtime-thread-time.cpio");
globalThis.bootSignalWaitRuntimeSmoke = () => bootRuntime("/runtime-signal-waits.cpio");
globalThis.bootSignalIoRuntimeSmoke = () => bootRuntime("/runtime-signal-io.cpio");
globalThis.bootSignalFutexRuntimeSmoke = () => bootRuntime("/runtime-signal-futex.cpio");
globalThis.bootFutexRuntimeSmoke = () => bootRuntime("/runtime-futex.cpio");
globalThis.bootRobustMutexRuntimeSmoke = () => bootRuntime("/runtime-robust-mutex.cpio");
globalThis.bootSemaphoreDeadlineRuntimeSmoke = () =>
  bootRuntime("/runtime-semaphore-deadline.cpio");
globalThis.bootFilesystemRuntimeSmoke = () => bootRuntime("/runtime-filesystem.cpio");
globalThis.bootQuickjsRuntimeSmoke = () => bootRuntime("/runtime-quickjs.cpio");
globalThis.bootLuaRuntimeSmoke = () => bootRuntime("/runtime-lua.cpio");
globalThis.bootLuaDevelopmentRuntimeSmoke = () => bootRuntime("/runtime-lua-development.cpio");
globalThis.bootOpensslRuntimeSmoke = () => bootRuntime("/runtime-openssl.cpio");
globalThis.bootCurlHttpsRuntimeSmoke = () => bootRuntime("/runtime-curl-https.cpio");
globalThis.bootLibcurlDevelopmentRuntimeSmoke = () =>
  bootRuntime("/runtime-libcurl-development.cpio");
