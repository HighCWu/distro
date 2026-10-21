// SPDX-License-Identifier: MIT
// Native C contract checks; not Wasm EH/Asyncify or target libc evidence.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const cc of process.env.BASH_FORK_HOST_CC ? [process.env.BASH_FORK_HOST_CC] : ["gcc", "clang"])
  test(`${cc}: saved C frame survives fork; mask and child-result corruption fail`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-sjlj-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = readFileSync(new URL("sjlj.c", import.meta.url), "utf8");
    const wrongChild = source.replace(
      "siglongjmp(env, code);",
      "siglongjmp(env, code == 9 ? 7 : code);",
    );
    const lostMask = source.replace("sigsetjmp(env, 1)", "sigsetjmp(env, 0)");
    assert.notEqual(wrongChild, source);
    assert.notEqual(lostMask, source);
    for (const [name, code] of [
      ["normal", source],
      ["wrong-child", wrongChild],
      ["lost-mask", lostMask],
    ]) {
      const input = join(dir, name + ".c"),
        output = join(dir, name);
      writeFileSync(input, code);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", output], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(output, [], { encoding: "utf8", timeout: 15000 });
      assert.equal(run.error, undefined);
      if (name === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.deepEqual(run.stdout.trim().split("\n"), [
          "fork-sjlj: siglongjmp after fork restores frames, masks and private TLS pass",
          "fork-sjlj: longjmp zero normalization and later fork/wait recovery pass",
          "::vm-test::pass",
        ]);
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          name === "wrong-child" ? /parent jump identity/ : /jump restores signal mask/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
