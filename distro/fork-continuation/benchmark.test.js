// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseProfileOutput, profileKinds } from "./benchmark-profile.js";
import { captureProfileOutput } from "./benchmark-profile-capture.js";
import { pairSchedule, summarizePair } from "./benchmark-pair.js";
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

test("worker pair requires all adjacent alternating fresh boots and uninstrumented evidence", () => {
  const m = manifest(),
    schedule = pairSchedule(m);
  assert.equal(schedule.length, 42);
  for (let i = 0; i < schedule.length; i += 2) {
    const a = schedule[i],
      b = schedule[i + 1];
    assert.equal(a.caseId, b.caseId);
    assert.equal(a.repeat, b.repeat);
    assert.notEqual(a.variant, b.variant);
  }
  assert.deepEqual(
    new Set(schedule.filter((s) => s.caseId === "fork-1").map((s) => s.variant)),
    new Set(["baseline", "bundled"]),
  );
  const boots = schedule.map((s) => ({
    ...boot(
      m,
      m.cases.find((c) => c.id === s.caseId),
      s.repeat,
    ),
    ...s,
  }));
  const report = summarizePair(boots, m);
  assert.equal(report.summary.baseline.length, 7);
  for (const r of report.ratios)
    for (const v of Object.values(r.bundledOverBaseline)) assert.equal(v, 1);
  assert.throws(() => summarizePair(boots.slice(1), m));
  assert.throws(() => summarizePair([...boots].reverse(), m));
  assert.throws(() => summarizePair(boots, { ...m, profile: true }));
  assert.throws(() =>
    summarizePair(
      boots.map((b, i) => (i === 0 ? { ...b, closed: false } : b)),
      m,
    ),
  );
  assert.throws(() =>
    summarizePair(
      boots.map((b, i) => (i === 0 ? { ...b, output: b.output + "::vm-test::fail\n" } : b)),
      m,
    ),
  );
});

test("bundle experiment stays private, preserves package inputs and gates measurements on recovery", () => {
  const bundle = readFileSync(new URL("./worker-bundle.nix", import.meta.url), "utf8");
  assert.match(bundle, /--format=esm --platform=neutral/);
  assert.match(bundle, /--tree-shaking=false --ignore-annotations --keep-names/);
  assert.match(bundle, /--legal-comments=inline/);
  assert.doesNotMatch(bundle, /--minify|--splitting/);
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /test -e \$\{bundledRuntime\}/);
  assert.match(recipe, /test -e \$\{bundledFaults\}/);
  assert.match(recipe, /copyFaultTest = true/);
  const runner = readFileSync(new URL("./benchmark-pair.mjs", import.meta.url), "utf8");
  assert.match(runner, /spawnSync\(process.execPath/);
  assert.match(runner, /150_000/);
  assert.match(runner, /kernel\/vmlinux.wasm/);
  assert.match(runner, /kernel\/dist\/index.js/);
  assert.match(runner, /assert.deepEqual\(manifests.baseline, manifests.bundled\)/);
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /fork-benchmark-worker-pair:/);
  assert.match(ci, /if \[\[ "\$WORKER_PAIR" == true \]\]; then test "\$PROFILE" != true; fi/);
});

test("paired driver saves all raw outputs, rejects changed inputs and never overwrites results", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fork-pair-driver-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = manifest();
  for (const name of [
    "benchmark-pair.mjs",
    "benchmark-pair.js",
    "benchmark-contract.js",
    "benchmark-profile.js",
  ])
    copyFileSync(new URL(name, import.meta.url), join(dir, name));
  for (const variant of ["baseline", "bundled"]) {
    const root = join(dir, variant);
    mkdirSync(join(root, "kernel/dist"), { recursive: true });
    mkdirSync(join(root, "binaries"));
    writeFileSync(join(root, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(root, "binaries/program.wasm"), "identical Wasm");
    writeFileSync(join(root, "kernel/vmlinux.wasm"), "identical kernel");
    writeFileSync(join(root, "kernel/dist/index.js"), "identical entry");
    writeFileSync(join(root, "kernel/dist/worker.js"), variant);
    writeFileSync(join(root, "kernel/worker-bundle-version.txt"), "fixture-only");
    writeFileSync(join(root, "kernel/worker-bundle-meta.json"), "{}");
    const fake = Object.fromEntries(m.cases.map((c) => [c.id, boot(m, c, 0)]));
    for (const b of Object.values(fake)) delete b.repeat;
    writeFileSync(
      join(root, "benchmark-boot.mjs"),
      `console.log(JSON.stringify(${JSON.stringify(fake)}[process.argv[3]]));`,
    );
    for (const c of m.cases) writeFileSync(join(root, `${c.id}.cpio`), "identical initramfs");
  }
  const run = (result) =>
    spawnSync(process.execPath, [join(dir, "benchmark-pair.mjs"), dir, result], {
      encoding: "utf8",
      timeout: 15000,
    });
  const result = join(dir, "results");
  const first = run(result);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /all 42 fresh boots, metrics and shutdown pass/);
  const report = JSON.parse(readFileSync(join(result, "report.json"), "utf8"));
  assert.equal(report.boots.length, 42);
  for (const b of report.boots)
    assert.ok(readFileSync(join(result, `${b.variant}-${b.repeat}-${b.caseId}.stdout`), "utf8"));
  assert.notEqual(run(result).status, 0);
  writeFileSync(join(dir, "bundled/binaries/program.wasm"), "changed");
  assert.notEqual(run(join(dir, "changed-results")).status, 0);
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

test("private host collector preserves ordinary errors, waits for all records and restores its logger", async () => {
  const forwarded = [];
  const logger = {
    error(...args) {
      assert.equal(this, logger);
      forwarded.push(args);
    },
  };
  const original = logger.error;
  const capture = captureProfileOutput(true, 2, logger);
  let done = false;
  void capture.completion.then(() => {
    done = true;
  });
  logger.error('fork-profile: {"one":1}\n');
  await Promise.resolve();
  assert.equal(done, false);
  logger.error("ordinary worker error", 42);
  assert.deepEqual(forwarded, [["ordinary worker error", 42]]);
  logger.error('fork-profile: {"two":2}');
  await capture.completion;
  assert.equal(done, true);
  assert.equal(capture.lines.length, 2);
  capture.restore();
  assert.equal(logger.error, original);
});

test("disabled host collection leaves the logger untouched and has no completion gate", () => {
  const logger = { error() {} };
  const original = logger.error;
  const capture = captureProfileOutput(false, 30, logger);
  assert.equal(logger.error, original);
  assert.equal(capture.completion, undefined);
  capture.restore();
  assert.equal(logger.error, original);
});

test("diagnostic admission requires all five phases for six distinct requests, including warmup", () => {
  const m = { ...manifest(), profile: true },
    c = m.cases.find((c) => c.kind === "fork");
  const records = Array.from({ length: 6 }, (_, i) => [
    { schemaVersion: 1, request: `copy-${i}`, kind: "worker-start-message", ns: 40 },
    { schemaVersion: 1, request: `copy-${i}`, kind: "parent-ready", ns: 100 },
    {
      schemaVersion: 1,
      request: `copy-${i}`,
      kind: "child-ready",
      ns: 50,
      allocate_ns: 5,
      copy_ns: 10,
      kernel_instance_ns: 15,
      user_instance_ns: 10,
    },
    { schemaVersion: 1, request: `copy-${i}`, kind: "child-prepare-rewind", ns: 0 },
    { schemaVersion: 1, request: `copy-${i}`, kind: "child-rewind-checkpoint", ns: 8 },
  ]).flat();
  const text = (list) => list.map((r) => `fork-profile: ${JSON.stringify(r)}`).join("\n");
  const valid = text(records);
  assert.equal(parseProfileOutput(valid, m, c).length, 6);
  assert.equal(
    parseProfileOutput(text([...records].reverse()), m, c).length,
    6,
    "arrival order across Workers is not a clock",
  );
  assert.equal(parseBenchmarkOutput(output(rows(m, c)) + "\n" + valid, m, c).length, 5);
  const corruptions = [
    records.slice(1),
    records.slice(5),
    [...records, records[0]],
    records.map((r, i) => (i === 0 ? { ...r, ns: -1 } : r)),
    records.map((r, i) => (i === 2 ? { ...r, copy_ns: null } : r)),
    records.map((r, i) => (i === 2 ? { ...r, kind: "rewind-start-only" } : r)),
    records.map((r, i) => (i === 3 ? { ...r, request: "wrong-id" } : r)),
  ];
  for (const list of corruptions) assert.throws(() => parseProfileOutput(text(list), m, c));
  assert.throws(
    () => parseProfileOutput(valid, manifest(), c),
    "baseline must not silently accept instrumentation",
  );
  assert.throws(
    () => parseProfileOutput(valid, m, m.cases[0]),
    "non-fork controls must remain clean",
  );
  assert.throws(() => parseProfileOutput("", m, c));
  assert.throws(() => validateManifest({ ...m, profile: "true" }));
});

test("version two requires startup subphases, rejects mixed versions, and keeps version one readable", () => {
  const m = { ...manifest(), profile: true, profileVersion: 2 },
    c = m.cases.find((c) => c.kind === "fork");
  validateManifest(m);
  assert.equal(profileKinds(m).length, 10);
  const records = Array.from({ length: 6 }, (_, i) =>
    profileKinds(m).map((kind) => ({
      schemaVersion: 2,
      request: `v2-${i}`,
      kind,
      ns: 100,
      ...(kind === "child-ready"
        ? { allocate_ns: 1, copy_ns: 2, kernel_instance_ns: 3, user_instance_ns: 4 }
        : {}),
      ...(kind === "worker-module-ready" ? { module_ns: 5 } : {}),
      ...(kind === "worker-init-posted" ? { queued_ns: 6, post_ns: 7 } : {}),
    })),
  ).flat();
  const text = (list) => list.map((r) => `fork-profile: ${JSON.stringify(r)}`).join("\n");
  assert.equal(parseProfileOutput(text(records), m, c).length, 6);
  assert.throws(() =>
    parseProfileOutput(text(records.filter((r) => r.kind !== "worker-online")), m, c),
  );
  assert.throws(() =>
    parseProfileOutput(text(records.map((r) => ({ ...r, schemaVersion: 1 }))), m, c),
  );
  assert.throws(() =>
    parseProfileOutput(
      text(records.map((r) => (r.kind === "worker-module-ready" ? { ...r, module_ns: -1 } : r))),
      m,
      c,
    ),
  );
  assert.throws(() =>
    parseProfileOutput(
      text(records.map((r) => (r.kind === "worker-init-posted" ? { ...r, queued_ns: null } : r))),
      m,
      c,
    ),
  );
  assert.throws(() => validateManifest({ ...m, profileVersion: 3 }));
  assert.throws(() => validateManifest({ ...m, profile: false }));
  assert.equal(profileKinds({ ...m, profileVersion: 1 }).length, 5);
});

test("diagnostic kernel selection is opt-in and incompatible with fault/signal seams", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  const kernel = readFileSync(new URL("../npm/kernel.nix", import.meta.url), "utf8");
  const worker = readFileSync(
    new URL("../../packages/kernel/src/worker.ts", import.meta.url),
    "utf8",
  );
  const seam = readFileSync(
    new URL("../../packages/kernel/src/fork-profile.ts", import.meta.url),
    "utf8",
  );
  assert.match(recipe, /benchmarkProfileAssets/);
  assert.match(recipe, /forkProfileTest = true/);
  assert.match(kernel, /forkProfileTest \? false/);
  assert.match(kernel, /profiling must not combine with fault or signal/);
  assert.match(seam, /export const fork_profile_test = false/);
  assert.match(worker, /profile\.measure\("allocate_ns"/);
  assert.match(worker, /profile\.measure\("copy_ns"/);
  assert.match(worker, /profile\.measure\("kernel_instance_ns"/);
  assert.match(worker, /profile\.measure\("user_instance_ns"/);
  assert.match(worker, /profile\.prepareChild/);
  assert.match(worker, /profile\.childRewound/);
  assert.match(worker, /type: "fork_profile_record"/);
  const main = readFileSync(new URL("../../packages/kernel/src/index.ts", import.meta.url), "utf8");
  assert.match(main, /case "fork_profile_record"/);
  assert.match(main, /create_fork_profile\(init.fork_profile, emit_fork_profile_record\)/);
  const platform = readFileSync(
    new URL("../../packages/kernel/src/platform.ts", import.meta.url),
    "utf8",
  );
  assert.match(platform, /fork_profile_test && handlers.profileStartup === true/);
  assert.match(platform, /profiling \? "\.\/fork-profile-worker.js" : "\.\/worker.js"/);
  assert.match(platform, /worker.on\("online", online\)/);
  assert.match(platform, /queue.stop\(\)/);
  assert.match(platform, /clearTimeout\(probe\)/);
  const boot = readFileSync(new URL("./benchmark-boot.mjs", import.meta.url), "utf8");
  assert.match(boot, /profileKinds\(m\).length/);
  assert.doesNotMatch(
    main,
    /create_fork_profile\(init.fork_profile,[\s\S]{0,100}boot_console_write/,
  );
  assert.match(
    worker,
    /4 \* copy_status_words\(\)/,
    "copy status and publication protocol are unchanged",
  );
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
  assert.match(ci, /fork-benchmark-width:/);
  assert.match(workflow, /bits: \$\{\{ fromJSON\(inputs.widths\) \}\}/);
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
