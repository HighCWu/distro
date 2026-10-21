// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertProcessOutput } from "../../packages/browser-tests/process-contract.js";

for (const cc of ["gcc", "clang"])
  test(`${cc}: native pidfd workload and false-success rejection`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pidfd-contract-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const original = readFileSync(new URL("process-control.c", import.meta.url), "utf8");
    const wrong = original.replace(
      "return syscall(SYS_pidfd_send_signal, (long)fd, (long)signal, 0L, (long)flags, 0L, 0L);",
      "(void)fd; (void)signal; (void)flags; return 0;",
    );
    assert.notEqual(wrong, original);
    for (const [name, source] of [
      ["normal", original],
      ["wrong-signal", wrong],
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
        assertProcessOutput(run.stdout, "pidfd");
      } else {
        assert.notEqual(run.status, 0);
        assert.match(run.stdout, /invalid descriptor/);
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
