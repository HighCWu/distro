// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertForkOutput, forkStages, forkFaultStages } from "./fork-contract.js";

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

test("browser runner boots both profiles twice and packages an isolated fault loader", () => {
  const runner = readFileSync(new URL("./fork-browser-check.mjs", import.meta.url), "utf8");
  assert.match(runner, /for \(const mode of \["normal", "faults"\]\)/);
  assert.match(runner, /iteration <= 2/);
  assert.match(runner, /bootForkRuntimeSmoke\(mode\)/);
  assert.match(runner, /assertForkOutput\(output, mode\)/);
  const app = readFileSync(new URL("./fork-app.js", import.meta.url), "utf8");
  assert.match(app, /mode === "faults" \? faults : normal/);
  assert.match(app, /mode === "faults" \? "\/faults.cpio" : "\/runtime.cpio"/);
  const recipe = readFileSync(
    new URL("../../distro/npm/browser-tests.nix", import.meta.url),
    "utf8",
  );
  assert.match(recipe, /faultAssets = runtime.checks.faults.runtimeAssets/);
  assert.match(recipe, /faultKernel = .*override \{ copyFaultTest = true; \}/s);
  assert.match(recipe, /cp \$\{faultAssets.initramfs\} \$out\/faults.cpio/);
  assert.match(
    recipe,
    /cp -r \$\{faultKernel\}\/\. \$out\/node_modules\/@lowland\/kernel-faults\//,
  );
});
