// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertForkOutput,
  forkStages,
  forkFaultStages,
  forkSignalStages,
  forkResumeSignalStages,
  forkIterations,
} from "./fork-contract.js";

test("stability profile requires four full iterations; default stays two and unknown inputs fail", () => {
  assert.equal(forkIterations(undefined), 2);
  assert.equal(forkIterations("1"), 4);
  for (const value of ["", "0", "2", "true", "100", null, 1])
    assert.throws(() => forkIterations(value), /unknown fork stability profile/);
});

test("fork browser gate requires every real workload stage, not only protocol pass", () => {
  const source = ["runtime.c", "exec-child.c"]
    .map((name) =>
      readFileSync(new URL(`../../distro/fork-continuation/${name}`, import.meta.url), "utf8"),
    )
    .join("\n");
  for (const stage of forkStages) assert.ok(source.includes(`"${stage}"`), stage);
  assert.doesNotThrow(() => assertForkOutput(forkStages.join("\n")));
  for (const missing of forkStages) {
    assert.throws(
      () => assertForkOutput(forkStages.filter((line) => line !== missing).join("\n")),
      /missing stage/,
    );
  }
  assert.throws(
    () => assertForkOutput(`${forkStages.join("\n")}\n::vm-test::fail: late error`),
    /reported failure/,
  );
  assert.throws(() => assertForkOutput(undefined), /missing runtime/);
  assert.throws(
    () => assertForkOutput(forkStages.map((line) => `prefix ${line}`).join("\n")),
    /missing stage/,
  );
});

test("fault gate requires both failure and recovery stages, not the normal corpus or final pass", () => {
  const source = readFileSync(
    new URL("../../distro/fork-continuation/fault-runtime.c", import.meta.url),
    "utf8",
  );
  for (const stage of forkFaultStages) assert.ok(source.includes(`"${stage}"`), stage);
  assert.doesNotThrow(() => assertForkOutput(forkFaultStages.join("\n"), "faults"));
  for (const missing of forkFaultStages)
    assert.throws(
      () =>
        assertForkOutput(forkFaultStages.filter((line) => line !== missing).join("\n"), "faults"),
      /missing stage/,
    );
  assert.throws(() => assertForkOutput(forkStages.join("\n"), "faults"), /missing stage/);
  assert.throws(() => assertForkOutput(forkFaultStages.join("\n")), /missing stage/);
  assert.throws(
    () => assertForkOutput(`${forkFaultStages.join("\n")}\n::vm-test::fail: late`, "faults"),
    /reported failure/,
  );
  assert.throws(() => assertForkOutput("::vm-test::pass", "invalid"), /unknown fork/);
});

for (const [mode, expected] of [
  ["signals", forkSignalStages],
  ["resume-signals", forkResumeSignalStages],
]) {
  test(`${mode} gate requires its own stages and rejects other profiles and late failure`, () => {
    const source = readFileSync(
      new URL("../../distro/fork-continuation/signal-runtime.c", import.meta.url),
      "utf8",
    );
    for (const stage of expected) assert.ok(source.includes(`"${stage}"`), stage);
    assert.doesNotThrow(() => assertForkOutput(expected.join("\n"), mode));
    for (const missing of expected)
      assert.throws(
        () => assertForkOutput(expected.filter((line) => line !== missing).join("\n"), mode),
        /missing stage/,
      );
    for (const [otherMode, stages] of [
      ["normal", forkStages],
      ["faults", forkFaultStages],
      ["signals", forkSignalStages],
      ["resume-signals", forkResumeSignalStages],
    ]) {
      if (otherMode === mode) continue;
      assert.throws(() => assertForkOutput(stages.join("\n"), mode), /missing stage/);
      assert.throws(() => assertForkOutput(expected.join("\n"), otherMode), /missing stage/);
    }
    assert.throws(
      () => assertForkOutput(`${expected.join("\n")}\n::vm-test::fail: late`, mode),
      /reported failure/,
    );
    assert.throws(
      () => assertForkOutput(expected.map((line) => `prefix ${line}`).join("\n"), mode),
      /missing stage/,
    );
    for (const mode of ["toString", "__proto__", "invalid"])
      assert.throws(() => assertForkOutput("::vm-test::pass", mode), /unknown fork/);
  });
}

test("browser app selects matching isolated loader and initramfs for each mode", async () => {
  const source = readFileSync(new URL("./fork-app.js", import.meta.url), "utf8");
  const app = {};
  const modes = ["normal", "faults", "signals", "resume-signals"];
  const loaders = modes.map((name) => ({
    bootMachine: name,
    consoleDevice: `${name}-console`,
    entropyDevice: `${name}-entropy`,
  }));
  const requests = [];
  const install = new Function(
    "normal",
    "faults",
    "signals",
    "resumeSignals",
    "runRuntimeSmoke",
    "crossOriginIsolated",
    "fetch",
    "globalThis",
    source.replace(/^import .*;\n/gm, ""),
  );
  install(
    ...loaders,
    (options) => options,
    true,
    async (path) => {
      requests.push(path);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    },
    app,
  );
  for (const [index, mode] of modes.entries()) {
    const options = app.bootForkRuntimeSmoke(mode);
    assert.equal(options.bootMachine, loaders[index].bootMachine);
    assert.equal(options.consoleDevice, loaders[index].consoleDevice);
    assert.equal(options.entropyDevice, loaders[index].entropyDevice);
    await options.loadInitramfs();
  }
  assert.deepEqual(requests, [
    "/runtime.cpio",
    "/faults.cpio",
    "/signals.cpio",
    "/resume-signals.cpio",
  ]);
  assert.equal(app.bootForkRuntimeSmoke().bootMachine, "normal");
  for (const mode of ["toString", "__proto__", "invalid"])
    assert.throws(() => app.bootForkRuntimeSmoke(mode), /unknown fork/);
  install(...loaders, () => assert.fail("must not boot without isolation"), false, null, app);
  for (const mode of modes)
    assert.throws(() => app.bootForkRuntimeSmoke(mode), /cross-origin isolation/);
});

test("browser runner repeats full profiles and packages independent fault and signal loaders", () => {
  const runner = readFileSync(new URL("./fork-browser-check.mjs", import.meta.url), "utf8");
  assert.match(runner, /for \(const mode of \["normal", "faults", "signals", "resume-signals"\]\)/);
  assert.match(
    runner,
    /const requiredIterations = mode === "normal" \|\| mode === "faults" \? iterations : 2/,
  );
  assert.match(runner, /iteration <= requiredIterations/);
  assert.match(runner, /forkIterations\(process.env.FORK_BROWSER_STABILITY\)/);
  assert.match(runner, /300_000/);
  assert.match(runner, /bootForkRuntimeSmoke\(mode\)/);
  assert.match(runner, /assertForkOutput\(output, mode\)/);
  const app = readFileSync(new URL("./fork-app.js", import.meta.url), "utf8");
  assert.match(app, /kernel-signals\/dist\/index.js/);
  assert.match(app, /kernel-resume-signals\/dist\/index.js/);
  const recipe = readFileSync(
    new URL("../../distro/npm/browser-tests.nix", import.meta.url),
    "utf8",
  );
  assert.match(recipe, /faultAssets = runtime.checks.faults.runtimeAssets/);
  assert.match(recipe, /signalAssets = runtime.checks.signals.runtimeAssets/);
  assert.match(recipe, /resumeSignalAssets = runtime.checks.resume-signals.runtimeAssets/);
  assert.match(recipe, /resumeSignalKernel = .*override \{\s*forkResumeSignalTest = true;\s*\}/s);
  assert.match(recipe, /resumeSignalAssets.disks == \[ \]/);
  assert.match(recipe, /resumeSignalAssets.cpus == 2/);
  assert.match(recipe, /cp \$\{resumeSignalAssets.initramfs\} \$out\/resume-signals.cpio/);
  assert.match(
    recipe,
    /cp -r \$\{resumeSignalKernel\}\/\. \$out\/node_modules\/@lowland\/kernel-resume-signals\//,
  );
  assert.match(recipe, /signalKernel = .*override \{ forkSignalTest = true; \}/s);
  assert.match(recipe, /signalAssets.disks == \[ \]/);
  assert.match(recipe, /signalAssets.cpus == 2/);
  assert.match(recipe, /cp \$\{signalAssets.initramfs\} \$out\/signals.cpio/);
  assert.match(
    recipe,
    /cp -r \$\{signalKernel\}\/\. \$out\/node_modules\/@lowland\/kernel-signals\//,
  );
  assert.match(recipe, /fork-wasm64-chromium-stability =/);
  assert.match(recipe, /overrideAttrs\s*\{\s*FORK_BROWSER_STABILITY = "1";\s*\}/);
  assert.match(recipe, /faultKernel = .*override \{ copyFaultTest = true; \}/s);
  assert.match(recipe, /cp \$\{faultAssets.initramfs\} \$out\/faults.cpio/);
  assert.match(
    recipe,
    /cp -r \$\{faultKernel\}\/\. \$out\/node_modules\/@lowland\/kernel-faults\//,
  );
});
