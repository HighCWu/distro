// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const cc of ["gcc", "clang"])
  test(`${cc}: native MAP_FIXED workload rejects ignoring replacement flags`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fixed-mmap-parity-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(new URL("fixed-mmap.c", import.meta.url), "utf8");
    const bad = source.replace(
      "flags | MAP_FIXED | MAP_NORESERVE | MAP_POPULATE, 12345, 0) == base + 2 * page",
      "flags | MAP_NORESERVE | MAP_POPULATE, 12345, 0) == base + 2 * page",
    );
    assert.ok(bad !== source);
    for (const [mode, body] of [
      ["normal", source],
      ["ignored", bad],
    ]) {
      const input = join(dir, "test.c"),
        binary = join(dir, "test");
      writeFileSync(input, body);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", binary], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      if (mode === "normal" && cc === "clang") {
        const analysis = spawnSync(
          cc,
          [
            "--analyze",
            "-Xanalyzer",
            "-analyzer-werror",
            "-Xanalyzer",
            "-analyzer-output=text",
            input,
            "-o",
            "/dev/null",
          ],
          { encoding: "utf8" },
        );
        assert.equal(analysis.status, 0, analysis.stderr);
      }
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.error, undefined);
      if (mode === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal((run.stdout.match(/::vm-test::pass/g) ?? []).length, 1);
        assert.match(run.stdout, /last old reference replacement, continued use and cleanup pass/);
      } else {
        assert.notEqual(run.status, 0);
        assert.match(run.stdout, /middle-page replacement/);
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
