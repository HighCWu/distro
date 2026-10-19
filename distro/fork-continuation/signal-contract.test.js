// SPDX-License-Identifier: MIT
// Native timing is atfork prepare/parent; exact continuation timing needs target checks.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const phase of [
  {
    name: "saved",
    flag: "fork_signal_test",
    inject: "inject_saved_fork_signal",
    other: "inject_resume_fork_signal",
  },
  {
    name: "post-clone",
    flag: "fork_resume_signal_test",
    inject: "inject_resume_fork_signal",
    other: "inject_saved_fork_signal",
  },
]) {
  test(`${phase.name} injection is independent, build-only and uses width-correct Linux syscalls`, async (t) => {
    const source = readFileSync(
      new URL("../../packages/kernel/src/fork-signal-test.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /export const fork_signal_test = false;/);
    assert.match(source, /export const fork_resume_signal_test = false;/);
    const dir = mkdtempSync(join(tmpdir(), "fork-signal-hook-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "enabled.mts");
    writeFileSync(
      path,
      source.replace(`export const ${phase.flag} = false;`, `export const ${phase.flag} = true;`),
    );
    const module = await import(pathToFileURL(path).href);
    const inject_saved_fork_signal = module[phase.inject];
    for (const width of ["i32", "i64"]) {
      const p = (value) => (width === "i64" ? BigInt(value) : value);
      const zero = p(0),
        calls = [];
      module[phase.other](() => assert.fail("other timing profile must stay disabled"), width);
      inject_saved_fork_signal((...args) => {
        calls.push(args);
        return args[0] === p(172) ? p(1234) : zero;
      }, width);
      assert.deepEqual(calls, [
        [p(172), zero, zero, zero, zero, zero, zero],
        [p(129), p(1234), p(10), zero, zero, zero, zero],
      ]);
      for (const invalid of [0, -3, 2147483648])
        assert.throws(
          () => inject_saved_fork_signal(() => p(invalid), width),
          /invalid parent PID/,
        );
      assert.throws(
        () => inject_saved_fork_signal(() => (width === "i64" ? 1234 : 1234n), width),
        /invalid parent PID/,
      );
      assert.throws(
        () => inject_saved_fork_signal((nr) => (nr === p(172) ? p(1234) : p(-3)), width),
        /kill failed/,
      );
    }
    const recipe = readFileSync(new URL("../npm/kernel.nix", import.meta.url), "utf8");
    assert.match(recipe, /forkSignalTest \? false/);
    assert.match(recipe, /forkResumeSignalTest \? false/);
    assert.match(recipe, /!\(forkSignalTest && forkResumeSignalTest\)/);
    const workload = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
    assert.match(workload, /checks.signals/);
    assert.match(workload, /kernel = kernel.override \{ forkSignalTest = true; \}/);
    assert.match(workload, /checks.resume-signals/);
    assert.match(workload, /kernel = kernel.override \{ forkResumeSignalTest = true; \}/);
    assert.match(workload, /-DFORK_SIGNAL_AFTER_CLONE -c/);
    assert.match(workload, /init = "\$\{program\}\/fork-resume-signal.wasm"/);
  });
}

for (const compiler of ["gcc", "clang"]) {
  for (const afterClone of [false, true]) {
    test(`${compiler}: ${afterClone ? "post-clone" : "saved"} signal baseline and omitted-injection control`, (t) => {
      const dir = mkdtempSync(join(tmpdir(), "fork-signal-native-"));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const source = fileURLToPath(new URL("./signal-runtime.c", import.meta.url));
      const binary = join(dir, "probe");
      for (const negative of [false, true]) {
        const built = spawnSync(
          compiler,
          [
            "-O2",
            "-pthread",
            "-Wall",
            "-Wextra",
            "-Werror",
            ...(afterClone ? ["-DFORK_SIGNAL_AFTER_CLONE"] : []),
            ...(negative ? ["-DFORK_SIGNAL_NEGATIVE_CONTROL"] : []),
            source,
            "-o",
            binary,
          ],
          { encoding: "utf8", timeout: 30000 },
        );
        assert.equal(built.status, 0, built.stderr);
        const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
        assert.equal(run.status, negative ? 120 : 0, run.stderr + run.stdout);
        if (negative) assert.match(run.stdout, /parent pending missing/);
        else {
          assert.match(run.stdout, /::vm-test::pass/);
          assert.match(
            run.stdout,
            afterClone ? /post-clone pre-rewind parent pending/ : /saved-fork parent pending/,
          );
          assert.doesNotMatch(
            run.stdout,
            afterClone ? /saved-fork parent pending/ : /post-clone pre-rewind parent pending/,
          );
        }
      }
    });
  }
}
