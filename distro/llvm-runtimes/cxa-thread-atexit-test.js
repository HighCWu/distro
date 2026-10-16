// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("libc++abi explicitly rejects a false-positive static-library symbol probe", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /"-DLIBCXXABI_HAS_CXA_THREAD_ATEXIT_IMPL=OFF"/);
  const root = mkdtempSync(join(tmpdir(), "sdk-cxa-probe-"));
  try {
    writeFileSync(
      join(root, "CMakeLists.txt"),
      `
cmake_minimum_required(VERSION 3.20)
project(cxa_probe C)
include(CheckLibraryExists)
check_library_exists(c linux_wasm_sdk_missing_cxa_thread_atexit_impl "" PROBE)
file(WRITE "\${CMAKE_BINARY_DIR}/probe.txt" "\${PROBE}")
`,
    );
    for (const [type, expected] of [
      ["STATIC_LIBRARY", true],
      ["EXECUTABLE", false],
    ]) {
      const build = join(root, type);
      const result = spawnSync(
        "cmake",
        ["-S", root, "-B", build, `-DCMAKE_TRY_COMPILE_TARGET_TYPE=${type}`],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        readFileSync(join(build, "probe.txt"), "utf8") === "1",
        expected,
        `${type}: static-library probes cannot certify libc link symbols`,
      );
    }
    const overridden = join(root, "override");
    const result = spawnSync(
      "cmake",
      [
        "-S",
        root,
        "-B",
        overridden,
        "-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY",
        "-DPROBE=OFF",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(overridden, "probe.txt"), "utf8"), "OFF");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
