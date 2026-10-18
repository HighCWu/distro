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

test("CMake cross mode links feature probes and separately builds a native generator", () => {
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
        "-DSDK_USE_BUILD_GENERATOR=ON",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CC_FOR_BUILD: process.env.CC_FOR_BUILD || "cc",
          AR_FOR_BUILD: process.env.AR_FOR_BUILD || "ar",
          RANLIB_FOR_BUILD: process.env.RANLIB_FOR_BUILD || "ranlib",
        },
      },
    );
    assert.equal(result.status, 0, `${result.error || ""}\n${result.stdout}\n${result.stderr}`);
    const cache = readFileSync(join(root, "build/CMakeCache.txt"), "utf8");
    assert.match(cache, /^SDK_HAS_MALLOC:INTERNAL=1$/m);
    assert.match(cache, /^SDK_HAS_MISSING_FUNCTION:INTERNAL=$/m);
    const built = spawnSync("cmake", ["--build", join(root, "build")], {
      encoding: "utf8",
      env: {
        ...process.env,
        CC: "/invalid-target-cc",
        AR: "/invalid-target-ar",
        CMAKE_TOOLCHAIN_FILE: "/invalid-target-toolchain.cmake",
        CFLAGS: "-invalid-target-flags",
        LDFLAGS: "-invalid-target-link-flags",
      },
    });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    // This cross-mode fixture deliberately uses native compilers. Executing
    // its output tests the fixture only, not the Wasm SDK or Linux runtime.
    const executed = spawnSync(join(root, "build/sdk-example.wasm"), [], { encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stdout + executed.stderr);
    assert.match(executed.stdout, /build-machine generator and target consumer verified/);
    assert.match(executed.stdout, /::vm-test::pass/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("static Wasm policy prevents Ninja install-time non-ELF RPATH relinking", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-cmake-install-rpath-"));
  try {
    const dependency = join(root, "dependency");
    mkdirSync(dependency);
    // A synthetic imported library makes CMake consider a runtime search path.
    // Nothing is linked here; this tests generation, not target library support.
    writeFileSync(join(dependency, "libprobe.so"), "generation-only fixture\n");
    writeFileSync(join(root, "main.c"), "int main(void) { return 0; }\n");
    writeFileSync(
      join(root, "CMakeLists.txt"),
      `cmake_minimum_required(VERSION 3.20)
project(rpath_generation C)
set(CMAKE_EXECUTABLE_FORMAT WASM)
add_library(probe UNKNOWN IMPORTED)
set_target_properties(probe PROPERTIES IMPORTED_LOCATION "${dependency}/libprobe.so")
add_executable(example main.c)
target_link_libraries(example PRIVATE probe)
install(TARGETS example RUNTIME DESTINATION bin)
`,
    );
    let template = readFileSync(new URL("./linux-wasm.cmake.in", import.meta.url), "utf8");
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
    for (const [name, policy, succeeds] of [
      ["sdk", template, true],
      ["without-policy", template.replace(/^set\(CMAKE_SKIP_RPATH .*\)\n/m, ""), false],
    ]) {
      const toolchain = join(root, `${name}.cmake`);
      writeFileSync(toolchain, policy);
      const result = spawnSync(
        "cmake",
        ["-S", root, "-B", join(root, name), "-G", "Ninja", `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`],
        { encoding: "utf8", timeout: 15_000 },
      );
      if (succeeds) assert.equal(result.status, 0, result.stdout + result.stderr);
      else {
        assert.notEqual(
          result.status,
          0,
          "fixture must reproduce the missing RPATH policy failure",
        );
        assert.match(result.stdout + result.stderr, /requires changing an RPATH/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
