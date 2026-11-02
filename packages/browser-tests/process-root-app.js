// SPDX-License-Identifier: MIT
import { bootMachine, blockDevice, consoleDevice, entropyDevice } from "@lowland/kernel";
import { runRuntimeSmoke } from "./runtime-smoke.js";

async function image(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`process image load failed: ${path}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

globalThis.bootProcessRuntimeSmoke = async () => {
  if (!crossOriginIsolated) throw new Error("process runtime requires cross-origin isolation");
  const response = await fetch("/profile.json");
  if (!response.ok) throw new Error(`process profile load failed: ${response.status}`);
  const { corpus, cpus } = await response.json();
  if (corpus !== "resolver" || cpus !== 2) throw new Error("invalid installed process profile");
  let root;
  return runRuntimeSmoke({
    cpus,
    bootMachine(options) {
      // Fresh disposable storage on every boot; no browser persistence claim.
      const storage = {
        capacity: root.byteLength,
        read(offset, target) {
          const bytes = root.subarray(offset, offset + target.byteLength);
          target.set(bytes);
          return bytes.byteLength;
        },
        write(offset, bytes) {
          root.set(bytes, offset);
          return bytes.byteLength;
        },
        flush() {},
      };
      return bootMachine({ ...options, plugins: [...options.plugins, blockDevice(storage)] });
    },
    consoleDevice,
    entropyDevice,
    async loadInitramfs() {
      const images = await Promise.all([image("/runtime.cpio"), image("/root.ext4")]);
      root = images[1];
      return images[0];
    },
  });
};
