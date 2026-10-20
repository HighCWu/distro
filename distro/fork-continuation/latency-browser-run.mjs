// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { cpus } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chromium, firefox } from "playwright";
import { latencyServer } from "./latency-server.js";
import { browserBoot } from "./latency-browser-boot.mjs";
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
const variants = ["native", "node", "chromium", "firefox"];
mkdirSync(results);
const server = latencyServer(assets);
await new Promise((accept, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", accept);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const boots = [];
try {
  for (const item of latencySchedule(m, variants)) {
    const { variant, repeat, caseId } = item;
    const prefix = join(results, `${variant}-${repeat}-${caseId}`);
    console.log(`fork browser compare: ${variant} ${repeat} ${caseId} begin`);
    let b;
    if (variant === "chromium" || variant === "firefox")
      b = await browserBoot({
        engine: variant,
        caseId,
        prefix,
        origin,
        engines: { chromium, firefox },
      });
    else {
      const native = variant === "native";
      const child = spawnSync(
        native ? join(assets, "native", caseId) : process.execPath,
        native
          ? [join(assets, "native/helper")]
          : [join(assets, "latency-boot.mjs"), assets, caseId],
        { encoding: "utf8", timeout: 150000, maxBuffer: 8 * 1024 * 1024 },
      );
      writeFileSync(prefix + ".stdout", child.stdout ?? "");
      writeFileSync(prefix + ".stderr", child.stderr ?? "");
      assert.equal(child.status, 0, `measurement failed: ${child.error?.message ?? child.stderr}`);
      b = native ? { output: child.stdout, closed: true } : JSON.parse(child.stdout);
    }
    parseLatency(
      b.output,
      m,
      m.cases.find((c) => c.id === caseId),
      variant,
    );
    assert.equal(b.closed, true);
    boots.push({ ...b, ...item });
    console.log(`fork browser compare: ${variant} ${repeat} ${caseId} and shutdown pass`);
  }
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const summary = latencySummary(boots, m, variants);
  const report = {
    schemaVersion: 1,
    experiment: "native-node-browser-fork-latency-v1",
    measuredAt: new Date().toISOString(),
    manifest: m,
    environment: {
      node: process.version,
      arch: process.arch,
      cpuModels: [...new Set(cpus().map((c) => c.model))],
      logicalHostCpus: cpus().length,
    },
    playwrightVersion: readFileSync(join(assets, "playwright-version.txt"), "utf8").trim(),
    compilers: Object.fromEntries(
      ["native", "wasm"].map((v) => [v, readFileSync(join(assets, v, "compiler.txt"), "utf8")]),
    ),
    sourceSha256: hash(join(assets, "latency.c")),
    helperSourceSha256: hash(join(assets, "latency-exec.c")),
    kernelSha256: hash(join(assets, "kernel/vmlinux.wasm")),
    binaries: Object.fromEntries(
      ["native", "wasm"].map((v) => [
        v,
        Object.fromEntries(
          readdirSync(join(assets, v))
            .filter((f) => !f.endsWith(".txt"))
            .map((f) => [f, hash(join(assets, v, f))]),
        ),
      ]),
    ),
    boots,
    summary,
    ratios: summary.map((s) => ({
      caseId: s.caseId,
      overNativeP50: Object.fromEntries(
        variants
          .filter((v) => v !== "native")
          .map((v) => [
            v,
            Object.fromEntries(
              ["parent_ns", "wait_ns"].map((p) => [
                p,
                s.variants[v][p].pooled.p50 / s.variants.native[p].pooled.p50,
              ]),
            ),
          ]),
      ),
    })),
    limitations: [
      "Same runner job, rotating order; host load and CPU affinity are uncontrolled.",
      "Each browser slot launches and closes a fresh headless browser, fresh page and Linux machine; native/Node slots use fresh OS processes. Browser startup is outside the C timing interval.",
      "Three boots per case/variant; pooled 90-sample tails are descriptive, not 90 independent boots.",
      "Native ABI/libc/COW differs from Wasm ABI/libc/eager-copy; these are end-to-end platform comparisons, not isolated ISA cost.",
      "All Wasm engines load the same binaries, kernel and initramfs paths. No bundling, profiler or performance thresholds.",
      "Fixed immutable assets are cacheable on loopback HTTP; each fresh browser has its own cache and the C workload has one warmup. This is not a remote-network or cold-cache startup benchmark.",
    ],
  };
  writeFileSync(join(results, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log("fork browser compare: all 72 measurement slots, samples and shutdown pass");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
