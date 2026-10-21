// SPDX-License-Identifier: MIT
import { bootMachine, blockDevice, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

export function pythonRootStorage(bytes) {
  return {
    capacity: bytes.byteLength,
    read(offset, target) {
      const source = bytes.subarray(offset, offset + target.byteLength);
      target.set(source);
      return source.byteLength;
    },
    write(offset, data) {
      bytes.set(data, offset);
      return data.byteLength;
    },
    // This disposable in-memory disk has no persistent writeback layer.
    flush() {},
  };
}

async function loadImage(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Python image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runPythonRuntime = (variant) => {
  if (variant !== "interpreter" && variant !== "mmap") throw new Error("invalid Python variant");
  let root;
  return runRuntimeSmoke({
    // Preserve target stages and completed shutdown in public CI evidence.
    // runRuntimeSmoke isolates diagnostics from completion/error semantics.
    onProgress(message) {
      console.info(`[Python ${variant}] ${message}`);
    },
    bootMachine(options) {
      return bootMachine({
        ...options,
        plugins: [...options.plugins, blockDevice(pythonRootStorage(root))],
      });
    },
    consoleDevice,
    entropyDevice,
    async loadInitramfs() {
      const images = await Promise.all([
        loadImage(`/runtime-${variant}.cpio`),
        loadImage(`/root-${variant}.ext4`),
      ]);
      root = images[1];
      return images[0];
    },
    timeoutMs: 240_000,
  });
};
