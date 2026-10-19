// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { validateManifest, validateBoot, summarizeBoots } from "./benchmark-contract.js";

assert.equal(process.argv.length, 4, "usage: benchmark-run.mjs assets new-results-directory");
const assets = resolve(process.argv[2]),
  results = resolve(process.argv[3]);
const m = validateManifest(JSON.parse(readFileSync(join(assets, "manifest.json"), "utf8")));
mkdirSync(results); // Do not overwrite a preceding measurement.
const binaries = Object.fromEntries(
  readdirSync(join(assets, "binaries"))
    .filter((name) => name.endsWith(".wasm"))
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(assets, "binaries", name));
      return [
        name,
        { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
      ];
    }),
);
const boots = [];
for (let repeat = 0; repeat < 3; repeat++) {
  // Alternate order to expose, not conceal, temporal drift. Each case still
  // gets a fresh OS process, fresh Workers, fresh kernel and its own warmup.
  const order = repeat % 2 ? [...m.cases].reverse() : m.cases;
  for (const c of order) {
    console.log(`fork benchmark: repeat ${repeat} ${c.id} begin`);
    const child = spawnSync(process.execPath, [join(assets, "benchmark-boot.mjs"), assets, c.id], {
      encoding: "utf8",
      timeout: 150_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(join(results, `${repeat}-${c.id}.stdout`), child.stdout ?? "");
    writeFileSync(join(results, `${repeat}-${c.id}.stderr`), child.stderr ?? "");
    assert.equal(child.status, 0, `fresh boot failed: ${child.error?.message ?? child.stderr}`);
    const boot = { ...JSON.parse(child.stdout), repeat };
    validateBoot(boot, m, c);
    boots.push(boot);
    console.log(`fork benchmark: repeat ${repeat} ${c.id} and shutdown pass`);
  }
}
const summary = summarizeBoots(boots, m);
const byId = Object.fromEntries(summary.map((s) => [s.caseId, s]));
const ratio = (numerator, denominator) =>
  Object.fromEntries(
    ["calls", "syscalls"].map((phase) => [
      phase,
      byId[numerator].timings[phase].medianOfBootMediansNs /
        byId[denominator].timings[phase].medianOfBootMediansNs,
    ]),
  );
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  manifest: m,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModels: [...new Set(cpus().map((cpu) => cpu.model))],
    logicalHostCpus: cpus().length,
  },
  compiler: readFileSync(join(assets, "binaries/compiler-version.txt"), "utf8"),
  binaries,
  boots,
  summary,
  ratios: {
    asyncifySameLink: ratio("fork-libc-asyncify", "fork-libc-raw"),
    sdkEndToEnd: ratio("sdk-asyncify", "default"),
  },
  limitations: [
    "Three fresh boots per case; samples inside one boot are not independent boots.",
    "RSS is Linux Node whole-process lifetime high-water KiB, including kernel, JIT, Workers and shutdown, not user-program RSS or browser memory.",
    "Linear bytes are allocation sizes, not resident memory or proof of complete resource reclamation.",
    "No absolute performance thresholds; CI hosts, JIT and scheduling can vary.",
    "Same-link Asyncify control omits the continuation object; the actual SDK's untransformed module is never admitted or booted.",
  ],
};
writeFileSync(join(results, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ summary, ratios: report.ratios }, null, 2));
console.log("fork benchmark: all fresh boots, metrics and shutdown pass");
