// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const source = fileURLToPath(new URL("../basic-init/tests/time-abi.c", import.meta.url));

for (const compiler of ["gcc", "clang"]) {
  test(`SDK time fixture builds and reaches its final stage with host ${compiler}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "sdk-time-host-"));
    try {
      const binary = join(directory, "time-abi");
      const compile = spawnSync(
        compiler,
        ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", binary],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.ifError(compile.error);
      assert.equal(compile.status, 0, compile.stderr);
      // The shared raw-initramfs fixture intentionally stays in sched_yield
      // after pass/fail. Bound the host execution and require the final stage
      // and pass record; a timeout alone is never evidence of success.
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" });
      assert.equal(run.error?.code, "ETIMEDOUT");
      assert.equal(run.signal, "SIGKILL");
      assert.match(
        run.stdout,
        /^time ABI: relative\/absolute timers, expiration and ready-fd waits verified\r?$/m,
      );
      assert.match(run.stdout, /^::vm-test::pass\r?$/m);
      assert.doesNotMatch(run.stdout, /::vm-test::fail/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
