// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertProcessOutput } from "../../packages/browser-tests/process-contract.js";

for (const cc of ["gcc", "clang"])
  test(`${cc}: descriptor exec, close_range and negative controls`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "exec-fd-contract-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const original = readFileSync(new URL("exec-fd.c", import.meta.url), "utf8");
    const leaked = original.replace("open(path, O_RDONLY | O_CLOEXEC)", "open(path, O_RDONLY)");
    const noop = original.replace(
      "return syscall(SYS_close_range, (long)first, (long)last, (long)flags, 0L, 0L, 0L);",
      "(void)first; (void)last; (void)flags; return 0;",
    );
    const lostCloexec = original.replace(
      "(long)last, (long)flags, 0L",
      "(long)last, (long)(flags & ~range_cloexec), 0L",
    );
    const exclusiveEnd = original.replace(
      "(long)last, (long)flags, 0L",
      "(long)(last == first ? last : last - 1), (long)flags, 0L",
    );
    assert.notEqual(leaked, original);
    assert.notEqual(noop, original);
    assert.notEqual(lostCloexec, original);
    assert.notEqual(exclusiveEnd, original);
    for (const [name, source] of [
      ["normal", original],
      ["leaked-executable", leaked],
      ["range-noop", noop],
      ["range-lost-cloexec", lostCloexec],
      ["range-exclusive-end", exclusiveEnd],
    ]) {
      const input = join(dir, name + ".c"),
        binary = join(dir, name);
      writeFileSync(input, source);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", binary], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 15000 });
      assert.equal(run.error, undefined);
      if (name === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assertProcessOutput(run.stdout, "execfd");
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          name === "range-noop"
            ? /range reversed bounds/
            : name === "range-exclusive-end"
              ? /range inclusivity, holes, upper bound and child isolation/
              : /replacement identity, TLS, inherited fd and CLOEXEC/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
