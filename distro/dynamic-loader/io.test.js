// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const compiler of ["gcc", "clang"]) {
  test(`${compiler}: private loader I/O ownership and failure recovery`, () => {
    const directory = mkdtempSync(join(tmpdir(), "wasm-dlopen-io-"));
    try {
      const file = join(directory, "module");
      const alias = join(directory, "alias");
      const empty = join(directory, "empty");
      const binary = join(directory, "check");
      writeFileSync(file, "private loader file bytes");
      linkSync(file, alias);
      writeFileSync(empty, "");
      const compile = spawnSync(
        compiler,
        [
          "-std=c11",
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          "-pthread",
          fileURLToPath(new URL("io-native.c", import.meta.url)),
          "-o",
          binary,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
      assert.equal(compile.status, 0, compile.stderr);
      const run = spawnSync(binary, [file, alias, empty, join(directory, "missing")], {
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(run.status, 0, run.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
