// SPDX-License-Identifier: MIT
import { bootMachine, blockDevice, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

export function gitRootStorage(bytes) {
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
    // Test-local memory storage, not durable browser persistence.
    flush() {},
  };
}

async function loadImage(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Git image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.runGitRuntime = (variant) => {
  if (!["workflow", "packing", "remote"].includes(variant)) throw new Error("invalid Git variant");
  let root;
  return runRuntimeSmoke({
    bootMachine(options) {
      return bootMachine({
        ...options,
        plugins: [...options.plugins, blockDevice(gitRootStorage(root))],
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
