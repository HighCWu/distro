// SPDX-License-Identifier: MIT
// Native timing is atfork prepare/parent/child; exact timing needs target checks.
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
  {
    name: "child",
    flag: "fork_child_signal_test",
    inject: "inject_child_fork_signal",
  },
]) {
  test(`${phase.name} injection is independent, build-only and uses width-correct Linux syscalls`, async (t) => {
    const source = readFileSync(
      new URL("../../packages/kernel/src/fork-signal-test.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /export const fork_signal_test = false;/);
    assert.match(source, /export const fork_resume_signal_test = false;/);
    assert.match(source, /export const fork_child_signal_test = false;/);
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
      for (const other of [
        "inject_saved_fork_signal",
        "inject_resume_fork_signal",
        "inject_child_fork_signal",
      ])
        if (other !== phase.inject)
          module[other](() => assert.fail("other timing profile must stay disabled"), width);
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
          /invalid signal target PID/,
        );
      assert.throws(
        () => inject_saved_fork_signal(() => (width === "i64" ? 1234 : 1234n), width),
        /invalid signal target PID/,
      );
      assert.throws(
        () => inject_saved_fork_signal((nr) => (nr === p(172) ? p(1234) : p(-3)), width),
        /kill failed/,
      );
    }
    const recipe = readFileSync(new URL("../npm/kernel.nix", import.meta.url), "utf8");
    assert.match(recipe, /forkSignalTest \? false/);
    assert.match(recipe, /forkResumeSignalTest \? false/);
    assert.match(recipe, /forkChildSignalTest \? false/);
    assert.match(recipe, /!\(forkSignalTest && forkResumeSignalTest\)/);
    assert.match(
      recipe,
      /!\(forkChildSignalTest && \(forkSignalTest \|\| forkResumeSignalTest\)\)/,
    );
    const workload = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
    assert.match(workload, /checks.signals/);
    assert.match(workload, /kernel = kernel.override \{ forkSignalTest = true; \}/);
    assert.match(workload, /checks.resume-signals/);
    assert.match(workload, /kernel = kernel.override \{ forkResumeSignalTest = true; \}/);
    assert.match(workload, /-DFORK_SIGNAL_AFTER_CLONE -c/);
    assert.match(workload, /init = "\$\{program\}\/fork-resume-signal.wasm"/);
    assert.match(workload, /checks.child-signals/);
    assert.match(workload, /kernel = kernel.override \{ forkChildSignalTest = true; \}/);
    assert.match(workload, /-DFORK_SIGNAL_CHILD -c/);
    assert.match(workload, /init = "\$\{program\}\/fork-child-signal.wasm"/);
    const worker = readFileSync(
      new URL("../../packages/kernel/src/worker.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      worker,
      /if \(fork_child_signal_test\) \{[\s\S]*call_entry = \(\) => \{[\s\S]*resume_fork_child/,
    );
    assert.match(worker, /continuation.kernelCall\(\(\) =>\s*inject_child_fork_signal/);
  });
}

for (const compiler of ["gcc", "clang"]) {
  for (const phase of ["saved", "post-clone", "child"]) {
    test(`${compiler}: ${phase} signal baseline and omitted-injection control`, (t) => {
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
            ...(phase === "post-clone" ? ["-DFORK_SIGNAL_AFTER_CLONE"] : []),
            ...(phase === "child" ? ["-DFORK_SIGNAL_CHILD"] : []),
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
        if (negative)
          assert.match(
            run.stdout,
            phase === "child" ? /child pending missing/ : /parent pending missing/,
          );
        else {
          assert.match(run.stdout, /::vm-test::pass/);
          assert.match(
            run.stdout,
            phase === "child"
              ? /child pre-rewind pending/
              : phase === "post-clone"
                ? /post-clone pre-rewind parent pending/
                : /saved-fork parent pending/,
          );
          assert.doesNotMatch(
            run.stdout,
            phase === "saved"
              ? /post-clone pre-rewind parent pending|child pre-rewind pending/
              : phase === "post-clone"
                ? /saved-fork parent pending|child pre-rewind pending/
                : /saved-fork parent pending|post-clone pre-rewind parent pending/,
          );
        }
      }
    });
  }
}
