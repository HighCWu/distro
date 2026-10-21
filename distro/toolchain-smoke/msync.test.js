// SPDX-License-Identifier: MIT
// Native Linux parity validates the workload, not target syscall admission.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const cc of ["gcc", "clang"])
  test(`${cc}: native private msync parity and false-success/writeback controls`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "private-msync-parity-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(new URL("msync.c", import.meta.url), "utf8");
    const fake = source.replace(
      "static void require(",
      "static int fake_sync(void *p, size_t n, int f) { (void)p; (void)n; (void)f; return 0; }\n#define msync fake_sync\nstatic void require(",
    );
    const shared = source.replace("MAP_PRIVATE, fd, 0", "MAP_SHARED, fd, 0");
    assert.ok(fake !== source && shared !== source);
    for (const [mode, body] of [
      ["normal", source],
      ["fake", fake],
      ["shared", shared],
    ]) {
      const input = join(dir, "test.c"),
        binary = join(dir, "test");
      writeFileSync(input, body);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", binary], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.error, undefined);
      if (mode === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.match(run.stdout, /adjacent live records recover/);
        assert.match(run.stdout, /private file dirty bytes do not write back/);
        assert.equal((run.stdout.match(/::vm-test::pass/g) ?? []).length, 1);
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          mode === "fake"
            ? /unaligned zero range/
            : /private file sync does not publish dirty bytes/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
