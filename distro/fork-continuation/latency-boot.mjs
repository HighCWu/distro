// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { latencyManifest, parseLatency } from "./latency-contract.js";
import { runRuntimeSmoke } from "./runtime-smoke.js";
assert.equal(process.argv.length, 4);
const assets = resolve(process.argv[2]);
const m = latencyManifest(JSON.parse(readFileSync(join(assets, "manifest.json"))));
const c = m.cases.find((c) => c.id === process.argv[3]);
assert.ok(c);
const kernel = await import(pathToFileURL(join(assets, "kernel/dist/index.js")).href);
const output = await runRuntimeSmoke({
  bootMachine: kernel.bootMachine,
  consoleDevice: kernel.consoleDevice,
  entropyDevice: kernel.entropyDevice,
  loadInitramfs: async () => new Uint8Array(readFileSync(join(assets, `${c.id}.cpio`))),
});
parseLatency(output, m, c, "node");
console.log(JSON.stringify({ output, closed: true }));
