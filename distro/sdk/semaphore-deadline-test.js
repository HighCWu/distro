// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const compiler of ["gcc", "clang"]) {
  test(`semaphore deadline workload matches host ${compiler}`, () => {
    const temp = mkdtempSync(join(tmpdir(), "wasm-sem-deadline-"));
    try {
      const binary = join(temp, "deadline");
      const compiled = spawnSync(
        compiler,
        [
          "-std=c11",
          "-O2",
          "-pthread",
          "-Wall",
          "-Wextra",
          "-Werror",
          fileURLToPath(new URL("../basic-init/tests/semaphore-deadline.c", import.meta.url)),
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.ifError(compiled.error);
      assert.equal(compiled.status, 0, compiled.stderr);
      const result = spawnSync(binary, [], {
        encoding: "utf8",
        timeout: 3000,
        killSignal: "SIGKILL",
      });
      assert.equal(result.error?.code, "ETIMEDOUT");
      assert.match(
        result.stdout,
        /semaphore deadlines: named\/unnamed past deadlines, invalid nanoseconds and token fast path verified/,
      );
      assert.match(result.stdout, /^::vm-test::pass$/m);
      assert.doesNotMatch(result.stdout, /::vm-test::fail/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
