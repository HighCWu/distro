// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { validateManifest, validateBoot } from "./benchmark-contract.js";
import { pairSchedule, summarizePair } from "./benchmark-pair.js";

assert.equal(process.argv.length, 4, "usage: benchmark-pair.mjs pair-assets new-results");
const assets = resolve(process.argv[2]),
  results = resolve(process.argv[3]);
const manifests = Object.fromEntries(
  ["baseline", "bundled"].map((v) => [
    v,
    validateManifest(JSON.parse(readFileSync(join(assets, v, "manifest.json"), "utf8"))),
  ]),
);
assert.deepEqual(manifests.baseline, manifests.bundled);
const m = manifests.baseline;
assert.notEqual(m.profile, true);
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const binaries = Object.fromEntries(
  readdirSync(join(assets, "baseline/binaries"))
    .filter((name) => name.endsWith(".wasm"))
    .sort()
    .map((name) => {
      const sha256 = hash(join(assets, "baseline/binaries", name));
      assert.equal(hash(join(assets, "bundled/binaries", name)), sha256);
      return [name, sha256];
    }),
);
for (const file of [
  "kernel/vmlinux.wasm",
  "kernel/dist/index.js",
  ...m.cases.map((c) => `${c.id}.cpio`),
])
  assert.equal(hash(join(assets, "baseline", file)), hash(join(assets, "bundled", file)), file);
mkdirSync(results);
const boots = [];
for (const item of pairSchedule(m)) {
  const { variant, repeat, caseId } = item;
  console.log(`fork pair: ${variant} ${repeat} ${caseId} begin`);
  const root = join(assets, variant);
  const child = spawnSync(process.execPath, [join(root, "benchmark-boot.mjs"), root, caseId], {
    encoding: "utf8",
    timeout: 150_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const name = `${variant}-${repeat}-${caseId}`;
  writeFileSync(join(results, `${name}.stdout`), child.stdout ?? "");
  writeFileSync(join(results, `${name}.stderr`), child.stderr ?? "");
  assert.equal(child.status, 0, `fresh boot failed: ${child.error?.message ?? child.stderr}`);
  const boot = { ...JSON.parse(child.stdout), ...item };
  validateBoot(
    boot,
    m,
    m.cases.find((c) => c.id === caseId),
  );
  boots.push(boot);
  console.log(`fork pair: ${variant} ${repeat} ${caseId} and shutdown pass`);
}
const report = {
  schemaVersion: 1,
  experiment: "worker-bundle-v1",
  measuredAt: new Date().toISOString(),
  manifest: m,
  environment: {
    node: process.version,
    cpuModels: [...new Set(cpus().map((c) => c.model))],
    logicalHostCpus: cpus().length,
  },
  binaries,
  workers: Object.fromEntries(
    ["baseline", "bundled"].map((v) => [v, hash(join(assets, v, "kernel/dist/worker.js"))]),
  ),
  bundlerVersion: readFileSync(
    join(assets, "bundled/kernel/worker-bundle-version.txt"),
    "utf8",
  ).trim(),
  bundleMetadata: JSON.parse(
    readFileSync(join(assets, "bundled/kernel/worker-bundle-meta.json"), "utf8"),
  ),
  boots,
  ...summarizePair(boots, m),
  limitations: [
    "Three adjacent alternating fresh-process pairs per case; within-boot samples are not independent boots.",
    "Uninstrumented Node only; no browser, pooling, COW or multithread fork claim.",
    "A single CI host run cannot establish a stable general speedup; no performance threshold.",
    "Only worker.js is bundled; index and kernel/user Wasm inputs are byte-identical.",
  ],
};
writeFileSync(join(results, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("fork pair: all 42 fresh boots, metrics and shutdown pass");
