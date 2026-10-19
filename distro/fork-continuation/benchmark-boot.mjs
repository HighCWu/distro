// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifest, parseBenchmarkOutput } from "./benchmark-contract.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";

assert.equal(process.platform, "linux", "peak RSS units are specified for Linux only");
assert.equal(process.argv.length, 4, "usage: benchmark-boot.mjs assets case-id");
const assets = resolve(process.argv[2]);
const m = validateManifest(JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8")));
const c = m.cases.find((value) => value.id === process.argv[3]);
assert.ok(c, "unknown benchmark case");
const kernel = await import(pathToFileURL(join(assets, "kernel/dist/index.js")).href);
let machine;
const output = await runRuntimeSmoke({
  bootMachine: async (options) => {
    machine = await kernel.bootMachine(options);
    return machine;
  },
  consoleDevice: kernel.consoleDevice,
  entropyDevice: kernel.entropyDevice,
  loadInitramfs: async () => new Uint8Array(readFileSync(join(assets, `${c.id}.cpio`))),
  completionReady:
    m.profile && c.kind === "fork"
      ? (output) =>
          output.split(/\r?\n/).filter((line) => line.startsWith("fork-profile: ")).length >=
          (m.samples + m.warmups) * 5
      : undefined,
});
// runRuntimeSmoke has awaited machine.closed and the final console callbacks.
parseBenchmarkOutput(output, m, c);
console.log(
  JSON.stringify({
    schemaVersion: 1,
    addressBits: m.addressBits,
    caseId: c.id,
    closed: true,
    peakProcessRssKiB: process.resourceUsage().maxRSS,
    kernelLinearBytes: machine.memory.buffer.byteLength,
    output,
  }),
);
