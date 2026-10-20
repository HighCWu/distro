// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  latencyCases,
  latencyManifest,
  parseLatency,
  latencySchedule,
  latencySummary,
  quantile,
} from "./latency-contract.js";
const manifest = () => ({
  schemaVersion: 1,
  addressBits: 64,
  samples: 30,
  warmups: 1,
  cpus: 2,
  cases: latencyCases,
});
const output = (m, c, v) =>
  Array.from(
    { length: m.samples },
    (_, sample) =>
      "fork-latency: " +
      JSON.stringify({
        sample,
        exec: c.exec,
        payload_bytes: c.payloadBytes,
        linear_bytes: v === "native" ? 0 : c.payloadBytes + 1048576,
        parent_ns: 100 + sample,
        wait_ns: 200 + sample,
      }),
  ).join("\n") + "\n::vm-test::pass\n";
test("latency admission requires all samples, native/linear distinction, pass and exact cases", () => {
  const m = manifest();
  latencyManifest(m);
  for (const v of ["native", "node"])
    for (const c of m.cases) {
      const good = output(m, c, v);
      assert.equal(parseLatency(good, m, c, v).length, 30);
      for (const bad of [
        good + "::vm-test::pass\n",
        good + "::vm-test::fail\n",
        good + "rcu: detected stall\n",
        good + "fork-profile: {}\n",
        good.split("\n").slice(1).join("\n"),
        good.replace('"sample":1,', '"sample":0,'),
        good.replace('"wait_ns":200', '"wait_ns":0'),
      ])
        assert.throws(() => parseLatency(bad, m, c, v));
    }
  assert.throws(() => latencyManifest({ ...m, samples: 5 }));
  assert.throws(() => latencyManifest({ ...m, warmups: 0 }));
  assert.throws(() => parseLatency(output(m, m.cases[0], "native"), m, m.cases[0], "node"));
  assert.throws(() => parseLatency(output(m, m.cases[0], "node"), m, m.cases[0], "native"));
});
test("latency schedule alternates paired processes and reports descriptive nearest-rank tails", () => {
  const m = manifest();
  const schedule = latencySchedule(m);
  assert.equal(schedule.length, 36);
  for (let i = 0; i < 36; i += 2) {
    assert.equal(schedule[i].caseId, schedule[i + 1].caseId);
    assert.notEqual(schedule[i].variant, schedule[i + 1].variant);
  }
  const boots = schedule.map((item) => ({
    ...item,
    closed: true,
    output: output(
      m,
      m.cases.find((c) => c.id === item.caseId),
      item.variant,
    ),
  }));
  const report = latencySummary(boots, m);
  assert.equal(report.length, 6);
  assert.deepEqual(report[0].variants.native.wait_ns.pooled, {
    samples: 90,
    p50: 214,
    p95: 228,
    max: 229,
  });
  assert.equal(report[0].variants.node.wait_ns.perBoot.length, 3);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.95), 5);
  assert.throws(() => latencySummary(boots.slice(1), m));
  assert.throws(() =>
    latencySummary(
      boots.map((b, i) => (i ? b : { ...b, closed: false })),
      m,
    ),
  );
});
for (const cc of ["gcc", "clang"])
  test(`${cc}: native fork/exec workload verifies snapshots, TLS, helper and single reap`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-native-latency-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = (name) => fileURLToPath(new URL(name, import.meta.url));
    const compile = (args) => {
      const p = spawnSync(cc, ["-O2", "-pthread", "-Wall", "-Wextra", "-Werror", ...args], {
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(p.status, 0, p.stderr);
    };
    const helper = join(dir, "helper");
    compile([source("latency-exec.c"), "-o", helper]);
    for (const c of latencyCases) {
      const binary = join(dir, c.id);
      compile([
        `-DLATENCY_MIB=${c.payloadBytes / 1048576}`,
        `-DLATENCY_EXEC=${c.exec}`,
        source("latency.c"),
        "-o",
        binary,
      ]);
      const p = spawnSync(binary, [helper], { encoding: "utf8", timeout: 10000 });
      assert.equal(p.status, 0, p.stdout + p.stderr);
      parseLatency(p.stdout, manifest(), c, "native");
      if (c.exec) {
        const bad = spawnSync(binary, [join(dir, "missing")], { encoding: "utf8", timeout: 5000 });
        assert.notEqual(bad.status, 0);
        assert.ok(!bad.stdout.includes("::vm-test::pass"));
      }
    }
  });
test("comparison uses one source, ordinary kernel, independent helper and exclusive modes", () => {
  const recipe = readFileSync(new URL("latency.nix", import.meta.url), "utf8");
  assert.match(recipe, /pkgs.stdenv.cc/);
  assert.match(recipe, /wasm-linux-fork-finalize/);
  assert.match(recipe, /files\."\/latency-helper"/);
  assert.doesNotMatch(recipe, /forkProfileTest|copyFaultTest|transformOnly|--bundle/);
  const driver = readFileSync(new URL("latency-run.mjs", import.meta.url), "utf8");
  assert.match(driver, /mkdirSync\(results\)/);
  assert.match(driver, /latencySchedule\(m\)/);
  assert.match(driver, /150000/);
  const workflow = readFileSync(
    new URL("../../.github/workflows/fork-benchmark.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /attribute=nativeComparisonAssets/);
});

test("same-host driver preserves raw evidence, compiler/input identity and all 36 process slots", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "latency-driver-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = manifest();
  for (const v of ["native", "wasm", "kernel"]) mkdirSync(join(dir, v));
  for (const file of ["latency-run.mjs", "latency-contract.js", "latency.c", "latency-exec.c"])
    copyFileSync(new URL(file, import.meta.url), join(dir, file));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "kernel/vmlinux.wasm"), "fixture kernel only");
  for (const v of ["native", "wasm"])
    writeFileSync(join(dir, v, "compiler.txt"), "fixture compiler only");
  const nodeResults = {};
  for (const c of m.cases) {
    writeFileSync(
      join(dir, "native", c.id),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output(m, c, "native"))});\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "wasm", c.id + ".wasm"), "fixture only");
    nodeResults[c.id] = { output: output(m, c, "node"), closed: true };
  }
  writeFileSync(
    join(dir, "latency-boot.mjs"),
    `console.log(JSON.stringify(${JSON.stringify(nodeResults)}[process.argv[3]]));`,
  );
  const result = join(dir, "results");
  const run = () =>
    spawnSync(process.execPath, [join(dir, "latency-run.mjs"), dir, result], {
      encoding: "utf8",
      timeout: 15000,
    });
  const p = run();
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /all 36 fresh processes, samples and shutdown pass/);
  const r = JSON.parse(readFileSync(join(result, "report.json")));
  assert.equal(r.boots.length, 36);
  assert.equal(r.experiment, "native-node-fork-latency-v1");
  for (const b of r.boots) {
    assert.ok(readFileSync(join(result, `${b.variant}-${b.repeat}-${b.caseId}.stdout`), "utf8"));
    assert.equal(
      readFileSync(join(result, `${b.variant}-${b.repeat}-${b.caseId}.stderr`), "utf8"),
      "",
    );
  }
  for (const s of r.ratios) assert.equal(s.nodeOverNativeP50.wait_ns, 1);
  assert.notEqual(run().status, 0, "must not overwrite evidence");
});
