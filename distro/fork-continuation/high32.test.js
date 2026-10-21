// SPDX-License-Identifier: MIT
// Native checks validate C state/isolation only, not the high Wasm layout.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const cc of ["gcc", "clang"])
  test(`${cc}: high-layout fork workload checks identity and private child state`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-high32-host-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(new URL("high32.c", import.meta.url), "utf8");
    for (const bad of [false, true]) {
      const contents = bad
        ? source.replace("getppid() == parent", "getppid() == parent + 1")
        : source;
      if (bad) assert.notEqual(contents, source);
      const input = join(dir, "probe.c"),
        binary = join(dir, "probe");
      writeFileSync(input, contents);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", binary], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.error, undefined);
      if (bad) {
        assert.notEqual(run.status, 0);
        assert.match(run.stdout, /child continuation, identity and private data/);
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      } else {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.match(run.stdout, /fork continuation, private data and single child reap pass/);
        assert.doesNotMatch(run.stdout, /upper-half stack/);
        assert.equal((run.stdout.match(/::vm-test::pass/g) ?? []).length, 1);
      }
    }
  });

test("high layout remains a separate wasm32 package and whole-link finalization", () => {
  const recipe = readFileSync(new URL("high32.nix", import.meta.url), "utf8");
  assert.match(recipe, /assert platform.addressBits == 32/);
  assert.match(recipe, /--global-base=2147483648/);
  assert.match(recipe, /--no-stack-first/);
  assert.match(recipe, /wasm-linux-fork-finalize linked.wasm/);
  assert.match(recipe, /cpus = 2/);
});
