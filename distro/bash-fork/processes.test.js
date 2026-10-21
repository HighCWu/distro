// SPDX-License-Identifier: MIT
// Native script and recipe checks, not Wasm/SjLj/Asyncify execution evidence.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("native Bash executes the full workload and rejects failed dependencies", (t) => {
  const work = mkdtempSync(join(tmpdir(), "bash-standard-fork-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const shell = process.env.BASH_FORK_HOST_SHELL || "/bin/bash";
  const run = (busybox) =>
    spawnSync(shell, [fileURLToPath(new URL("processes.sh", import.meta.url))], {
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        BASH_ENV: "",
        ENV: "",
        LC_ALL: "C",
        BASH_FORK_TEST_HOST: "1",
        BASH_FORK_TEST_WORK: work,
        BASH_FORK_TEST_SHELL: shell,
        BASH_FORK_TEST_BUSYBOX: busybox,
      },
    });
  const normal = run(process.env.BASH_FORK_HOST_BUSYBOX || "/bin/busybox");
  assert.equal(normal.error, undefined);
  assert.equal(normal.status, 0, normal.stdout + normal.stderr);
  assert.equal(normal.stderr, "");
  assert.deepEqual(normal.stdout.trim().split("\n"), [
    "bash-fork: standard fork, local scopes, command substitution and pipelines pass",
    "bash-fork: process substitution and coprocess fd lifetimes pass",
    "bash-fork: background wait, signal trap and parent isolation pass",
    "bash-fork: exec errors, syntax recovery and later child execution pass",
    "::vm-test::pass",
  ]);
  const failed = run(process.env.BASH_FORK_HOST_FALSE || "/bin/false");
  assert.notEqual(failed.status, 0);
  assert.match(failed.stdout, /::vm-test::fail: bash-fork: create workspace/);
  assert.doesNotMatch(failed.stdout, /::vm-test::pass/);
});

test("candidate reuses upstream material without default Bash callback patches", () => {
  const recipe = readFileSync(new URL("package.nix", import.meta.url), "utf8");
  assert.match(recipe, /inherit \(bash\) version src/);
  assert.match(recipe, /toString bash.gnuPatches/);
  assert.match(recipe, /patches = \[ ..\/bash\/wasm-anonfile.patch \]/);
  assert.doesNotMatch(recipe, /bash-clone\.c|fork-shim\.c|Dvfork=fork/);
  assert.match(recipe, /wasm-linux-fork-finalize bash bash.wasm/);
  assert.match(recipe, /cp COPYING/);
  assert.match(recipe, /gpl3Plus/);
  assert.match(recipe, /cpus = 2/);
});
