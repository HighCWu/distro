// SPDX-License-Identifier: MIT
// Native fixture checks only; target execution is a separate heavy check.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const stages = [
  "dash: subshell, external exec and command substitution pass",
  "dash: pipelines and inherited fd redirection pass",
  "dash: background wait and foreground exit status pass",
  "dash: command errors, syntax unwind and later exec recovery pass",
  "::vm-test::pass",
];
test("native Dash executes the complete process workload and refuses failed dependencies", (t) => {
  const work = mkdtempSync(join(tmpdir(), "dash-process-host-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const shell = process.env.DASH_HOST_SHELL || "/bin/dash";
  const run = (busybox) =>
    spawnSync(shell, [fileURLToPath(new URL("./processes.sh", import.meta.url))], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        DASH_TEST_HOST: "1",
        DASH_TEST_WORK: work,
        DASH_TEST_SHELL: shell,
        DASH_TEST_BUSYBOX: busybox,
      },
    });
  const result = run(process.env.DASH_HOST_BUSYBOX || "/bin/busybox");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(result.stdout.trim().split("\n"), stages);
  const failed = run(process.env.DASH_HOST_FALSE || "/bin/false");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /::vm-test::fail: dash: create workspace/);
  assert.doesNotMatch(failed.stdout, /::vm-test::pass/);
});

test("candidate preserves upstream source and keeps the fork fallback application-local", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /CFLAGS='-O2 -Dvfork=fork'/);
  assert.match(recipe, /CC_FOR_BUILD = "\$\{pkgs.stdenv.cc\}\/bin\/cc"/);
  assert.match(recipe, /wasm-linux-fork-finalize src\/dash dash.wasm/);
  assert.match(recipe, /cp COPYING/);
  assert.match(recipe, /bsd3\s+gpl2Plus/);
  assert.match(recipe, /cpus = 2/);
  assert.doesNotMatch(recipe, /patches\s*=|substituteInPlace|callback.clone/);
});
