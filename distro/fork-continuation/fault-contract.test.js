// SPDX-License-Identifier: MIT
// Host evidence only; the faults checks boot the actual Wasm kernel/libc.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("default fault seam is disabled; a build-only substitution enables a finite per-machine plan", async (t) => {
  const source = readFileSync(
    new URL("../../packages/kernel/src/copy-fault.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export const copy_fault_test = false;/);
  const dir = mkdtempSync(join(tmpdir(), "copy-fault-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "enabled.mts");
  writeFileSync(
    path,
    source.replace("export const copy_fault_test = false;", "export const copy_fault_test = true;"),
  );
  const enabled = await import(pathToFileURL(path).href);
  const first = enabled.create_copy_fault_plan(),
    second = enabled.create_copy_fault_plan();
  for (const expected of ["initialize", "allocate", null, null]) {
    assert.equal(first(), expected);
    assert.equal(second(), expected);
  }
  assert.throws(
    () => enabled.inject_copy_fault("initialize", "initialize"),
    /injected copy initialize/,
  );
  assert.throws(() => enabled.inject_copy_fault("allocate", "allocate"), /injected copy allocate/);
  assert.doesNotThrow(() => enabled.inject_copy_fault("initialize", "allocate"));
  const recipe = readFileSync(new URL("../npm/kernel.nix", import.meta.url), "utf8");
  assert.match(recipe, /copyFaultTest \? false/);
  assert.match(recipe, /postPatch = lib.optionalString copyFaultTest/);
  const workload = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(workload, /checks.faults/);
  assert.match(workload, /kernel = kernel.override \{ copyFaultTest = true; \}/);
  assert.match(workload, /init = "\$\{program\}\/fork-fault.wasm"/);
});

for (const compiler of ["gcc", "clang"]) {
  test(`${compiler}: native recovery workload passes without claiming injected Wasm failures`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-fault-native-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = fileURLToPath(new URL("./fault-runtime.c", import.meta.url));
    const binary = join(dir, "probe");
    const built = spawnSync(
      compiler,
      ["-O2", "-pthread", "-Wall", "-Wextra", "-Werror", source, "-o", binary],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /eight recovery forks, identity, TLS, isolation and single reap pass/);
    assert.match(run.stdout, /::vm-test::pass/);
    assert.doesNotMatch(run.stdout, /initialization and allocation errors/);
  });
}
