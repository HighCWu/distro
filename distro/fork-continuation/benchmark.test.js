// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  benchmarkCases,
  validateManifest,
  parseBenchmarkOutput,
  validateBoot,
  summarizeBoots,
  workChecksum,
} from "./benchmark-contract.js";

const manifest = () => ({
  schemaVersion: 1,
  addressBits: 32,
  samples: 5,
  warmups: 1,
  cpus: 2,
  workIterations: 262144,
  syscallIterations: 4096,
  cases: benchmarkCases.map(([id, kind, variant, payloadBytes]) => ({
    id,
    kind,
    variant,
    payloadBytes,
    binary: `${id}.wasm`,
  })),
});
function rows(m, c) {
  return Array.from({ length: m.samples }, (_, sample) =>
    c.kind === "work"
      ? [
          {
            kind: "work",
            phase: "calls",
            sample,
            iterations: m.workIterations,
            ns: 100 + sample,
            checksum: workChecksum(m.workIterations),
            linear_bytes: 1048576,
          },
          {
            kind: "work",
            phase: "syscalls",
            sample,
            iterations: m.syscallIterations,
            ns: 200 + sample,
            checksum: m.syscallIterations,
            linear_bytes: 1048576,
          },
        ]
      : [
          {
            kind: "fork",
            sample,
            payload_bytes: c.payloadBytes,
            parent_ns: 100 + sample,
            wait_ns: 200 + sample,
            linear_bytes: c.payloadBytes + 1048576,
          },
        ],
  ).flat();
}
const output = (samples) =>
  samples.map((row) => `fork-bench: ${JSON.stringify(row)}`).join("\n") + "\n::vm-test::pass\n";
const boot = (m, c, repeat) => ({
  schemaVersion: 1,
  addressBits: m.addressBits,
  caseId: c.id,
  closed: true,
  peakProcessRssKiB: 100000,
  kernelLinearBytes: 1048576,
  output: output(rows(m, c)),
  repeat,
});

test("manifest fixes bounded fresh workloads and excludes the SDK's untransformed ABI module", () => {
  const m = manifest();
  assert.equal(validateManifest(m), m);
  for (const field of ["samples", "cpus", "warmups", "workIterations", "addressBits"])
    assert.throws(() => validateManifest({ ...m, [field]: 0 }));
  assert.throws(() => validateManifest({ ...m, cases: [...m.cases, m.cases[0]] }));
  assert.throws(() =>
    validateManifest({
      ...m,
      cases: [{ ...m.cases[0], binary: "../other.wasm" }, ...m.cases.slice(1)],
    }),
  );
});

test("measurement parsing refuses missing/duplicate/wrong samples, checksums, native memory and RCU stalls", () => {
  const m = manifest();
  for (const c of m.cases) {
    const samples = rows(m, c),
      good = output(samples);
    assert.equal(parseBenchmarkOutput(good, m, c).length, samples.length);
    for (const wrong of [
      output(samples.slice(1)),
      output([...samples, samples[0]]),
      good + "::vm-test::fail: late\n",
      good + "rcu: INFO: rcu_sched detected stalls\n",
      good.replace("::vm-test::pass", "prefix ::vm-test::pass"),
      good + "::vm-test::pass\n",
      output([{ ...samples[0], linear_bytes: 0 }, ...samples.slice(1)]),
      output([{ ...samples[0], sample: 999 }, ...samples.slice(1)]),
      output([{ ...samples[0], kind: "other" }, ...samples.slice(1)]),
      output([samples[0], { ...samples[0], phase: "invented" }, ...samples.slice(2)]),
      output([
        { ...samples[0], ...(c.kind === "work" ? { checksum: -1 } : { payload_bytes: 0 }) },
        ...samples.slice(1),
      ]),
      output([
        { ...samples[0], ...(c.kind === "work" ? { ns: 0 } : { wait_ns: 1 }) },
        ...samples.slice(1),
      ]),
    ])
      assert.throws(() => parseBenchmarkOutput(wrong, m, c));
  }
});

test("only three complete fresh boots per case certify grouped medians and process memory", () => {
  const m = manifest(),
    boots = m.cases.flatMap((c) => [0, 1, 2].map((repeat) => boot(m, c, repeat)));
  const summary = summarizeBoots(boots, m);
  assert.equal(summary.length, 7);
  assert.equal(summary[0].timings.calls.medianOfBootMediansNs, 102);
  assert.deepEqual(summary[0].timings.calls.bootMediansNs, [102, 102, 102]);
  assert.throws(() => summarizeBoots(boots.slice(1), m));
  assert.throws(() => summarizeBoots([{ ...boots[0], repeat: 1 }, ...boots.slice(1)], m));
  for (const patch of [
    { closed: false },
    { peakProcessRssKiB: 0 },
    { addressBits: 64 },
    { caseId: "other" },
  ])
    assert.throws(() => validateBoot({ ...boots[0], ...patch }, m, m.cases[0]));
});

test("fresh measurement runs in the distro cache scope without the ordinary heavy matrix", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/fork-benchmark.yml", import.meta.url),
    "utf8",
  );
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /nix-targeted-v1-\$\{\{ runner.os \}\}-wasm\$\{\{ matrix.bits \}\}-/);
  assert.doesNotMatch(workflow, /repository:|sources\/distro/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /node result-fork-benchmark\/benchmark-run.mjs/);
  assert.match(ci, /uses: \.\/.github\/workflows\/fork-benchmark.yml/);
  assert.match(ci, /!inputs\['python-forkless-host'\] && !inputs\['fork-benchmark'\]/);
  assert.match(ci, /needs: benchmark-mode/);
  assert.match(ci, /test -z "\$REQUESTED_HEAVY_CHECK"/);
  assert.match(ci, /test "\$PYTHON_FORKLESS_HOST" != true/);
});

test("assets, admission controls and fresh-process driver remain explicit", () => {
  const recipe = readFileSync(new URL("./benchmark.nix", import.meta.url), "utf8");
  assert.match(recipe, /flagsFor sdk-fork-continuation.sysroot/);
  assert.match(
    recipe,
    /wasm-linux-fork-finalize \$out\/fork-libc-raw.wasm \$out\/fork-libc-asyncify.wasm/,
  );
  assert.match(recipe, /wasm-linux-fork-finalize \$out\/sdk-linked.wasm \$out\/sdk-asyncify.wasm/);
  assert.doesNotMatch(recipe, /rawInitramfsTest/);
  const driver = readFileSync(new URL("./benchmark-run.mjs", import.meta.url), "utf8");
  assert.match(driver, /spawnSync\(process.execPath/);
  assert.match(driver, /repeat < 3/);
  assert.match(driver, /150_000/);
  assert.match(driver, /summarizeBoots\(boots, m\)/);
  const child = readFileSync(new URL("./benchmark-boot.mjs", import.meta.url), "utf8");
  assert.match(child, /await runRuntimeSmoke/);
  assert.match(child, /process.resourceUsage\(\).maxRSS/);
  assert.match(child, /process.platform, "linux"/);
});

for (const compiler of ["gcc", "clang"]) {
  test(`${compiler}: native fixture validates work, fork isolation and reaping, not Wasm timing`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-benchmark-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = fileURLToPath(new URL("./benchmark.c", import.meta.url));
    for (const fork of [0, 1]) {
      const binary = join(dir, `probe-${fork}`);
      const built = spawnSync(
        compiler,
        [
          "-O2",
          "-pthread",
          "-Wall",
          "-Wextra",
          "-Werror",
          `-DBENCH_FORK=${fork}`,
          "-DBENCH_SAMPLES=2",
          "-DBENCH_ITERATIONS=4096",
          "-DBENCH_SYSCALLS=32",
          source,
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(built.status, 0, built.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.match(run.stdout, /::vm-test::pass/);
      const samples = run.stdout
        .split("\n")
        .filter((line) => line.startsWith("fork-bench: "))
        .map((line) => JSON.parse(line.slice(12)));
      assert.equal(samples.length, fork ? 2 : 4);
      assert.ok(
        samples.every((row) => row.linear_bytes === 0),
        "native values must not masquerade as Wasm memory",
      );
      if (!fork) assert.equal(samples[0].checksum, workChecksum(4096));
    }
  });
}
