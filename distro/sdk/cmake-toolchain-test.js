// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("CMake toolchain links feature probes without running target programs", () => {
  const source = dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "sdk-cmake-probes-"));
  try {
    let template = readFileSync(join(source, "linux-wasm.cmake.in"), "utf8");
    // Host tools exercise CMake cross-compilation semantics cheaply. Actual
    // Wasm compiler/linker probes run in the SDK's cmake-runtime check.
    for (const [key, value] of Object.entries({
      wasmArch: "sdk-probe-host",
      cc: "cc",
      cxx: "c++",
      ar: "ar",
      ranlib: "ranlib",
      sysroot: "/",
      pkgConfig: "pkg-config",
    }))
      template = template.replaceAll(`@${key}@`, value);
    const toolchain = join(root, "toolchain.cmake");
    writeFileSync(toolchain, template);
    const result = spawnSync(
      "cmake",
      [
        "-S",
        join(source, "cmake-example"),
        "-B",
        join(root, "build"),
        "-G",
        "Ninja",
        `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    const cache = readFileSync(join(root, "build/CMakeCache.txt"), "utf8");
    assert.match(cache, /^SDK_HAS_MALLOC:INTERNAL=1$/m);
    assert.match(cache, /^SDK_HAS_MISSING_FUNCTION:INTERNAL=$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
