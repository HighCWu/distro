// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("CMake finds host tools but isolates target headers, libraries and packages", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-cmake-roots-"));
  try {
    const target = join(root, "target");
    const host = join(root, "host");
    for (const prefix of [target + "/usr", host]) {
      for (const dir of ["include", "lib/cmake/SdkProbe", "bin"])
        mkdirSync(join(prefix, dir), { recursive: true });
      writeFileSync(join(prefix, "include/sdk-probe.h"), "/* fixture */\n");
      writeFileSync(join(prefix, "lib/libsdk-probe.a"), "fixture\n");
      writeFileSync(
        join(prefix, "lib/cmake/SdkProbe/SdkProbeConfig.cmake"),
        `set(SDK_PROBE_ORIGIN "${prefix}")\n`,
      );
      writeFileSync(join(prefix, "bin/sdk-probe-tool"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    writeFileSync(join(host, "include/host-only.h"), "/* poison */\n");
    writeFileSync(join(host, "lib/libhost-only.a"), "poison\n");
    const template = readFileSync(
      new URL("./linux-wasm.cmake.in", import.meta.url),
      "utf8",
    ).replaceAll("@sysroot@", target);
    writeFileSync(join(root, "toolchain.cmake"), template);
    const script = join(root, "check.cmake");
    writeFileSync(
      script,
      `
include("${root}/toolchain.cmake")
set(CMAKE_PREFIX_PATH "${host}")
set(CMAKE_SYSTEM_PREFIX_PATH "/usr")
set(CMAKE_FIND_LIBRARY_PREFIXES "lib")
set(CMAKE_FIND_LIBRARY_SUFFIXES ".a")
find_program(PROBE_TOOL sdk-probe-tool REQUIRED)
find_path(PROBE_HEADER sdk-probe.h REQUIRED)
find_library(PROBE_LIBRARY sdk-probe REQUIRED)
find_package(SdkProbe CONFIG REQUIRED)
find_path(HOST_HEADER host-only.h)
find_library(HOST_LIBRARY host-only)
if(NOT PROBE_TOOL STREQUAL "${host}/bin/sdk-probe-tool")
  message(FATAL_ERROR "host tool lookup failed")
endif()
if(NOT PROBE_HEADER STREQUAL "${target}/usr/include" OR
   NOT PROBE_LIBRARY STREQUAL "${target}/usr/lib/libsdk-probe.a" OR
   NOT SDK_PROBE_ORIGIN STREQUAL "${target}/usr")
  message(FATAL_ERROR "target lookup escaped sysroot")
endif()
if(HOST_HEADER OR HOST_LIBRARY)
  message(FATAL_ERROR "host-only dependency leaked into target lookup")
endif()
`,
    );
    const result = spawnSync("cmake", ["-P", script], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
