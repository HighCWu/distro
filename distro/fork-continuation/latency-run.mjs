// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { cpus } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  latencyManifest,
  latencySchedule,
  parseLatency,
  latencySummary,
} from "./latency-contract.js";
assert.equal(process.argv.length, 4);
assert.equal(process.platform, "linux");
const assets = resolve(process.argv[2]),
  results = resolve(process.argv[3]);
const m = latencyManifest(JSON.parse(readFileSync(join(assets, "manifest.json"))));
mkdirSync(results);
const boots = [];
for (const item of latencySchedule(m)) {
  const { variant, repeat, caseId } = item;
  console.log(`fork native compare: ${variant} ${repeat} ${caseId} begin`);
  const native = variant === "native";
  const command = native ? join(assets, "native", caseId) : process.execPath;
  const args = native
    ? [join(assets, "native/helper")]
    : [join(assets, "latency-boot.mjs"), assets, caseId];
  const child = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 150000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const prefix = join(results, `${variant}-${repeat}-${caseId}`);
  writeFileSync(prefix + ".stdout", child.stdout ?? "");
  writeFileSync(prefix + ".stderr", child.stderr ?? "");
  assert.equal(child.status, 0, `measurement failed: ${child.error?.message ?? child.stderr}`);
  const b = native ? { output: child.stdout, closed: true } : JSON.parse(child.stdout);
  parseLatency(
    b.output,
    m,
    m.cases.find((c) => c.id === caseId),
    variant,
  );
  assert.equal(b.closed, true);
  boots.push({ ...b, ...item });
  console.log(`fork native compare: ${variant} ${repeat} ${caseId} and shutdown pass`);
}
const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const binaries = Object.fromEntries(
  ["native", "wasm"].map((v) => [
    v,
    Object.fromEntries(
      readdirSync(join(assets, v))
        .filter((f) => !f.endsWith(".txt"))
        .map((f) => [f, hash(join(assets, v, f))]),
    ),
  ]),
);
const summary = latencySummary(boots, m);
const report = {
  schemaVersion: 1,
  experiment: "native-node-fork-latency-v1",
  measuredAt: new Date().toISOString(),
  manifest: m,
  environment: {
    node: process.version,
    arch: process.arch,
    cpuModels: [...new Set(cpus().map((c) => c.model))],
    logicalHostCpus: cpus().length,
  },
  compilers: {
    native: readFileSync(join(assets, "native/compiler.txt"), "utf8"),
    wasm: readFileSync(join(assets, "wasm/compiler.txt"), "utf8"),
  },
  sourceSha256: hash(join(assets, "latency.c")),
  helperSourceSha256: hash(join(assets, "latency-exec.c")),
  kernelSha256: hash(join(assets, "kernel/vmlinux.wasm")),
  binaries,
  boots,
  summary,
  ratios: summary.map((s) => ({
    caseId: s.caseId,
    nodeOverNativeP50: Object.fromEntries(
      ["parent_ns", "wait_ns"].map((p) => [
        p,
        s.variants.node[p].pooled.p50 / s.variants.native[p].pooled.p50,
      ]),
    ),
  })),
  limitations: [
    "Native uses the host ABI/libc and COW; Wasm uses the opt-in static single-thread SDK and eager copy. This is an end-to-end platform comparison, not isolated ISA cost.",
    "Payload touch and child snapshot verification are equal; total address spaces are not equal. Native linear_bytes=0 means not applicable, not zero memory.",
    "Three fresh processes per variant/case, one warmup and 30 samples per process. Pooled 90-sample tails are descriptive, clustered within only three boots, not independent statistical evidence.",
    "Measured intervals exclude initial Linux boot but include fork, child validation, exit or exec helper and wait as labeled. Exec helper loader/compiler costs are part of the platform result.",
    "Node only: no browser performance result. No background-load or CPU-affinity guarantee; no performance pass threshold.",
  ],
};
writeFileSync(join(results, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log("fork native compare: all 36 fresh processes, samples and shutdown pass");
