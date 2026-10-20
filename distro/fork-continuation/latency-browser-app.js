// SPDX-License-Identifier: MIT
import { bootMachine, consoleDevice, entropyDevice } from "./kernel/dist/index.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";

globalThis.runForkLatency = async (caseId) => {
  if (!crossOriginIsolated) throw Error("latency measurement requires cross-origin isolation");
  const response = await fetch("/manifest.json");
  if (!response.ok) throw Error(`manifest HTTP ${response.status}`);
  const manifest = await response.json();
  if (!manifest.cases.some((c) => c.id === caseId)) throw Error("unknown latency case");
  const output = await runRuntimeSmoke({
    bootMachine,
    consoleDevice,
    entropyDevice,
    loadInitramfs: async () => {
      const response = await fetch(`/${caseId}.cpio`);
      if (!response.ok) throw Error(`initramfs HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
  return { output, closed: true };
};
