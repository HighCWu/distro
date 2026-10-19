// SPDX-License-Identifier: MIT
// Native timing is atfork prepare; only target checks inject after suspension.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("saved-fork injection is build-only and uses real width-correct Linux syscalls", async (t) => {
  const source = readFileSync(
    new URL("../../packages/kernel/src/fork-signal-test.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export const fork_signal_test = false;/);
  const dir = mkdtempSync(join(tmpdir(), "fork-signal-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "enabled.mts");
  writeFileSync(
    path,
    source.replace(
      "export const fork_signal_test = false;",
      "export const fork_signal_test = true;",
    ),
  );
  const { inject_saved_fork_signal } = await import(pathToFileURL(path).href);
  for (const width of ["i32", "i64"]) {
    const p = (value) => (width === "i64" ? BigInt(value) : value);
    const zero = p(0),
      calls = [];
    inject_saved_fork_signal((...args) => {
      calls.push(args);
      return args[0] === p(172) ? p(1234) : zero;
    }, width);
    assert.deepEqual(calls, [
      [p(172), zero, zero, zero, zero, zero, zero],
      [p(129), p(1234), p(10), zero, zero, zero, zero],
    ]);
    for (const invalid of [0, -3, 2147483648])
      assert.throws(() => inject_saved_fork_signal(() => p(invalid), width), /invalid parent PID/);
    assert.throws(
      () => inject_saved_fork_signal((nr) => (nr === p(172) ? p(1234) : p(-3)), width),
      /kill failed/,
    );
  }
  const recipe = readFileSync(new URL("../npm/kernel.nix", import.meta.url), "utf8");
  assert.match(recipe, /forkSignalTest \? false/);
  const workload = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(workload, /checks.signals/);
  assert.match(workload, /kernel = kernel.override \{ forkSignalTest = true; \}/);
});

for (const compiler of ["gcc", "clang"]) {
  test(`${compiler}: inherited signal baseline passes and omitted injection fails`, (t) => {
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
      else assert.match(run.stdout, /::vm-test::pass/);
    }
  });
}
