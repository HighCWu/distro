// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("C++ configuration preserves Wasm exception handlers", (context) => {
  const compiler = process.env.SDK_TEST_CLANG || "clang++-22";
  const version = spawnSync(compiler, ["--version"], { encoding: "utf8" });
  if (!process.env.SDK_TEST_CLANG && version.error?.code === "ENOENT") {
    context.skip("Clang 22 is not installed; SDK CI uses its pinned compiler");
    return;
  }
  assert.equal(version.status, 0, version.stderr || String(version.error));
  const targets = process.env.SDK_TEST_TARGET
    ? [process.env.SDK_TEST_TARGET]
    : ["wasm32-unknown-unknown", "wasm64-unknown-unknown"];
  const config =
    process.env.SDK_TEST_CXX_CONFIG ||
    fileURLToPath(new URL("../llvm-toolchain/clang++.cfg", import.meta.url));
  const source = fileURLToPath(new URL("./exception-probe.cc", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "sdk-exception-codegen-"));
  try {
    for (const target of targets) {
      const output = join(root, "probe.s");
      const result = spawnSync(
        compiler,
        [
          `--config=${config}`,
          `--target=${target}`,
          "-mllvm",
          "-wasm-enable-sjlj",
          "-O1",
          "-S",
          source,
          "-o",
          output,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, `${target}: ${result.error || ""}\n${result.stderr}`);
      const assembly = readFileSync(output, "utf8");
      assert.match(assembly, /\b__cpp_exception\b/, `${target}: C++ exception tag missing`);
      assert.match(
        assembly,
        /\bcatch(?:_all|_ref|_all_ref)?\b/,
        `${target}: exception handler was discarded`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
