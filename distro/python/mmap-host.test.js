// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("Python anonymous buffer fixture runs on the native interpreter", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./mmap-test.py", import.meta.url))], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /private anonymous bytes, buffer lifetime and close verified/);
  assert.doesNotMatch(result.stdout, /default shared and file mappings rejected/);
});

test("target fixture requires explicit kernel rejection checks, without overriding mmap probes", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.doesNotMatch(recipe, /py_cv_module_mmap=|ac_cv_func_mmap_fixed_mapped=yes/);
  assert.match(recipe, /mmap = vm-test\.installedTest/);
  assert.ok(recipe.includes('files."/mmap-test.py" = ./mmap-test.py;'));
  const script = readFileSync(new URL("./mmap-test.sh", import.meta.url), "utf8");
  assert.match(script, /python3 \/mmap-test.py --kernel-boundaries; then/);
  assert.match(script, /python3 \/python-abi-test.py "\$\(cat \/python-address-bits\)"/);
  assert.equal(spawnSync("sh", ["-n"], { input: script }).status, 0);
});
