// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const cc of ["gcc", "clang"])
  test(`${cc}: native discard and non-destructive POSIX semantics`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "madvise-parity-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(new URL("madvise.c", import.meta.url), "utf8");
    const fake = source.replace(
      "static void require(",
      "static int fake(void *p, size_t n, int a) { (void)p; (void)n; (void)a; return 0; }\n#define madvise fake\nstatic void require(",
    );
    const destructive = source.replace(
      "posix_madvise(base, 3 * page, POSIX_MADV_DONTNEED)",
      "madvise(base, 3 * page, MADV_DONTNEED)",
    );
    assert.ok(fake !== source && destructive !== source);
    for (const [mode, body] of [
      ["normal", source],
      ["fake", fake],
      ["destructive", destructive],
    ]) {
      const input = join(dir, "test.c"),
        binary = join(dir, "test");
      writeFileSync(input, body);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", binary], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      if (mode === "normal" && cc === "clang") {
        const review = spawnSync(
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
        assert.equal(review.status, 0, review.stderr);
      }
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.error, undefined);
      if (mode === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal((run.stdout.match(/::vm-test::pass/g) ?? []).length, 1);
        assert.match(run.stdout, /released range rejection and cleanup pass/);
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          mode === "fake" ? /discard scope and zero bytes/ : /hints preserve bytes/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
