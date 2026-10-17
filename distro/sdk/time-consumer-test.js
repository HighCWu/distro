// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const [fixture, finalStage] of [
  ["time-abi", "time ABI: relative/absolute timers, expiration and ready-fd waits verified"],
  [
    "signal-waits",
    "signal waits: ppoll/pselect/sigsuspend mask handoff, EINTR, timeout and readiness verified",
  ],
  [
    "signal-io",
    "signal I/O: partial progress, explicit suffix retry, EINTR/restart and single child reaping verified",
  ],
  [
    "signal-futex",
    "signal futex: untimed restart, timed EINTR, explicit wake and queue cleanup verified",
  ],
  [
    "thread-time-abi",
    "thread time ABI: wakeups, cancellation, broadcast, timeouts and mutex ownership verified",
  ],
]) {
  const source = fileURLToPath(new URL(`../basic-init/tests/${fixture}.c`, import.meta.url));
  for (const compiler of ["gcc", "clang"]) {
    test(`SDK ${fixture} fixture builds and reaches its final stage with host ${compiler}`, () => {
      const directory = mkdtempSync(join(tmpdir(), "sdk-time-host-"));
      try {
        const binary = join(directory, "time-abi");
        const compile = spawnSync(
          compiler,
          ["-std=c11", "-O2", "-pthread", "-Wall", "-Wextra", "-Werror", source, "-o", binary],
          { encoding: "utf8", timeout: 30000 },
        );
        assert.ifError(compile.error);
        assert.equal(compile.status, 0, compile.stderr);
        // The shared raw-initramfs fixture intentionally stays in sched_yield
        // after pass/fail. Bound the host execution and require the final stage
        // and pass record; a timeout alone is never evidence of success.
        const run = spawnSync(binary, [], {
          encoding: "utf8",
          timeout: 3000,
          killSignal: "SIGKILL",
        });
        assert.equal(run.error?.code, "ETIMEDOUT");
        assert.equal(run.signal, "SIGKILL");
        assert.ok(run.stdout.split(/\r?\n/).includes(finalStage), run.stdout);
        assert.match(run.stdout, /^::vm-test::pass\r?$/m);
        assert.doesNotMatch(run.stdout, /::vm-test::fail/);
        if (fixture === "signal-io") {
          // Negative control: removing SA_RESTART must make the wait assertion
          // fail, rather than accidentally passing without exercising a signal.
          const original = readFileSync(source, "utf8");
          const disabled = original.replace(
            "action.sa_flags = restart ? SA_RESTART : 0;",
            "action.sa_flags = 0;",
          );
          assert.notEqual(disabled, original);
          const compileDisabled = spawnSync(
            compiler,
            [
              "-std=c11",
              "-O2",
              "-pthread",
              "-Wall",
              "-Wextra",
              "-Werror",
              "-I",
              dirname(source),
              "-x",
              "c",
              "-",
              "-o",
              binary,
            ],
            { encoding: "utf8", input: disabled, timeout: 30000 },
          );
          assert.ifError(compileDisabled.error);
          assert.equal(compileDisabled.status, 0, compileDisabled.stderr);
          const rejected = spawnSync(binary, [], {
            encoding: "utf8",
            timeout: 3000,
            killSignal: "SIGKILL",
          });
          assert.equal(rejected.error?.code, "ETIMEDOUT");
          assert.equal(rejected.signal, "SIGKILL");
          assert.match(
            rejected.stdout,
            /SA_RESTART wait exposed EINTR or lost the child exit status/,
          );
          assert.match(
            rejected.stdout,
            /^::vm-test::fail: SA_RESTART wait exposed EINTR or lost the child exit status\r?$/m,
          );
          assert.doesNotMatch(rejected.stdout, /::vm-test::pass/);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
}
