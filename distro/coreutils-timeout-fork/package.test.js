// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const recipe = readFileSync(join(directory, "package.nix"), "utf8");
const runtime = readFileSync(join(directory, "runtime-test.sh"), "utf8");
const nativeReference = readFileSync(join(directory, "native-reference.sh"), "utf8");
const helper = readFileSync(join(directory, "timeout-signal-helper.c"), "utf8");

function phase(name) {
  const match = recipe.match(new RegExp(name + "\\s*=\\s*''([\\s\\S]*?)'';"));
  assert.ok(match, "missing " + name);
  return match[1];
}

test("candidate builds unpatched coreutils timeout with automatic polling fork support", () => {
  assert.match(recipe, /inherit \(coreutils\) version src/);
  assert.doesNotMatch(recipe, /^\s*patches\s*=/m);
  assert.match(recipe, /cmp \$\{coreutils\.src\}\/src\/timeout\.c src\/timeout\.c/);
  assert.match(recipe, /sha256sum src\/timeout\.c > timeout-source\.sha256/);
  assert.match(recipe, /CONFIG_SITE=\$\{sdk-fork-automatic-poll-libc\.configSite\}/);
  assert.match(recipe, /CC=wasm-linux-fork-cc/);
  assert.match(recipe, /--host=\$\{lib\.escapeShellArg platform\.targetTriple\}/);
  for (const option of ["--disable-nls", "--disable-acl", "--disable-libcap", "--without-selinux"])
    assert.ok(recipe.includes('"' + option + '"'), "missing configure option " + option);

  const build = phase("buildPhase");
  assert.match(build, /node --test \$\{\.\/\.\}\/package\.test\.js/);
  assert.match(build, /sdk-generated-headers: \$\(BUILT_SOURCES\)/);
  assert.match(build, /make .*sdk-generated-headers/);
  assert.match(build, /make .*src\/timeout/);
  assert.doesNotMatch(build, /wasm-linux-fork-finalize/);
  assert.match(build, /linux_user_poll_v2/);
  assert.match(recipe, /sdk-fork-automatic-poll-libc\.buildMaterials/);
  assert.match(recipe, /coreutils-COPYING/);
  assert.match(recipe, /LOCAL-ADDITIONS\.MIT/);
  assert.match(recipe, /installedTest/);
  assert.match(recipe, /meta\s*=\s*\{[\s\S]*?outputsToInstall\s*=\s*\[\s*"out"\s*\];/);
});

test("runtime corpus requires timeout statuses, signal order, and later recovery", () => {
  assert.match(runtime, /watchdog.*timeout/);
  assert.match(runtime, /ordinary command exit status/);
  assert.match(runtime, /--ignore-term/);
  assert.match(runtime, /\[ "\$status" -eq 137 \]/);
  assert.match(runtime, /--preserve-status/);
  assert.match(runtime, /\[ "\$status" -eq 42 \]/);
  assert.match(runtime, /exec ENOENT/);
  assert.match(runtime, /\[ "\$status" -eq 127 \]/);
  assert.match(runtime, /failed to run command/);
  assert.match(runtime, /command after ENOENT/);
  assert.match(nativeReference, /GNU coreutils/);
  assert.match(nativeReference, /runtime-test\.sh/);

  assert.match(helper, /sigaction\(SIGTERM/);
  assert.match(helper, /CLOCK_MONOTONIC/);
  assert.match(helper, /volatile unsigned long work/);
  assert.doesNotMatch(helper, /fork\(|sleep\s*\(/);
});
