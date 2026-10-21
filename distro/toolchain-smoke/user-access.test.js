// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const cc of ["gcc", "clang"])
  test(`${cc}: native NULL syscall errors, side effects and recovery`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "user-access-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const original = readFileSync(new URL("user-access.c", import.meta.url), "utf8");
    for (const mode of ["normal", "false-uname", "bad-write"]) {
      const source =
        mode === "normal"
          ? original
          : original.replace(
              "return syscall(nr, a, b, c, d, e, f);",
              mode === "false-uname"
                ? "if (nr == SYS_uname && !a) { return 0; }\n  return syscall(nr, a, b, c, d, e, f);"
                : `if (nr == SYS_write && !b && c == 1) {
            char byte = 'X'; if (write((int)a, &byte, 1) != 1) return -1;
            errno = EFAULT; return -1;
          } return syscall(nr, a, b, c, d, e, f);`,
            );
      if (mode !== "normal") assert.notEqual(source, original);
      const input = join(dir, mode + ".c"),
        output = join(dir, mode);
      writeFileSync(input, source);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", output], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(output, [], { encoding: "utf8", timeout: 10000 });
      assert.equal(run.error, undefined);
      if (mode === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal((run.stdout.match(/user-access:.* pass/g) ?? []).length, 2);
        assert.equal((run.stdout.match(/::vm-test::pass/g) ?? []).length, 1);
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          mode === "false-uname" ? /NULL structure output/ : /failed write queues no bytes/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
