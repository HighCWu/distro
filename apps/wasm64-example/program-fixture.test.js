// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("native input fixture verifies every binary byte and rejects corruption", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-input-fixture-"));
  try {
    const binary = join(directory, "program");
    const compiled = spawnSync(
      process.env.HOST_CC ?? "cc",
      [
        "-Wall",
        "-Wextra",
        "-Werror",
        "-O2",
        fileURLToPath(new URL("./program-check.c", import.meta.url)),
        "-o",
        binary,
      ],
      { encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.error?.message ?? compiled.stderr);
    const bytes = Buffer.from(
      Uint8Array.from({ length: 512 * 1024 + 17 }, (_, i) => (i * 37 + 11) & 255),
    );
    for (const [mode, input, expected] of [
      [
        "pattern",
        bytes,
        `input bytes: ${bytes.length}, sum: ${bytes.reduce((sum, byte) => sum + byte, 0)}\n`,
      ],
      ["pattern", Buffer.alloc(0), "input bytes: 0, sum: 0\n"],
      ["prefix", bytes, "prefix byte: 11\n"],
    ]) {
      const result = spawnSync(binary, [mode], { input, encoding: "utf8", timeout: 5000 });
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      assert.equal(result.stdout, expected);
    }
    bytes[40000] ^= 1;
    assert.equal(spawnSync(binary, ["pattern"], { input: bytes, timeout: 5000 }).status, 7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
