// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const compiler of ["g++", "clang++"]) {
  test(`C++ filesystem consumer executes and removes its workspace with ${compiler}`, () => {
    const root = mkdtempSync(join(tmpdir(), "sdk-filesystem-test-"));
    try {
      const binary = join(root, "consumer");
      const built = spawnSync(
        compiler,
        [
          "-std=c++17",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          fileURLToPath(new URL("./filesystem-example.cc", import.meta.url)),
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.ifError(built.error);
      assert.equal(built.status, 0, built.stderr);
      const result = spawnSync(binary, [], {
        env: { ...process.env, TMPDIR: root },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(
        result.stdout,
        /C\+\+ filesystem: binary copy, links, time64 metadata, directory iteration and errors verified/,
      );
      assert.match(result.stdout, /^::vm-test::pass$/m);
      assert.doesNotMatch(result.stdout, /::vm-test::fail/);
      assert.deepEqual(readdirSync(root), ["consumer"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
