// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("CMake installs a stripped consumer with target libraries and a native generator", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-installed-"));
  const source = dirname(fileURLToPath(import.meta.url));
  const toolchain = process.env.SDK_TEST_CMAKE_TOOLCHAIN;
  const env = {
    ...process.env,
    WASM_PKG_CONFIG_PATH: join(root, "prefix/lib/pkgconfig"),
    WASM_PKG_CONFIG_SYSROOT_DIR: "/",
    CC_FOR_BUILD: process.env.CC_FOR_BUILD || "cc",
    AR_FOR_BUILD: process.env.AR_FOR_BUILD || "ar",
    RANLIB_FOR_BUILD: process.env.RANLIB_FOR_BUILD || "ranlib",
  };
  const buildEnvironment = {
    CC: "/invalid-target-cc",
    CXX: "/invalid-target-cxx",
    AR: "/invalid-target-ar",
    RANLIB: "/invalid-target-ranlib",
    CMAKE_TOOLCHAIN_FILE: "/invalid-inherited-target-toolchain.cmake",
    CFLAGS: "-invalid-target-cflags",
    CXXFLAGS: "-invalid-target-cxxflags",
    CPPFLAGS: "-invalid-target-cppflags",
    LDFLAGS: "-invalid-target-ldflags",
  };
  const run = (command, args, overrides = {}) => {
    const result = spawnSync(command, args, { env: { ...env, ...overrides }, encoding: "utf8" });
    assert.equal(
      result.status,
      0,
      `${command}: ${result.error || ""}\n${result.stdout}\n${result.stderr}`,
    );
    return result;
  };
  const configure = [
    "-G",
    "Ninja",
    "-DCMAKE_BUILD_TYPE=RelWithDebInfo",
    "-DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON",
    // CMake must not re-root the explicitly staged dependency into SDK sysroot.
    `-DCMAKE_STAGING_PREFIX=${join(root, "prefix")}`,
  ];
  if (toolchain) configure.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`);
  else
    configure.push(
      "-DCMAKE_FIND_ROOT_PATH=/unused-sdk-sysroot",
      "-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY",
    );
  try {
    let pkgConfig = process.env.SDK_TEST_PKG_CONFIG;
    if (!pkgConfig) {
      pkgConfig = join(root, "wasm-linux-pkg-config");
      const template = readFileSync(join(source, "pkg-config.sh"), "utf8");
      writeFileSync(
        pkgConfig,
        "#!/usr/bin/env bash\n" +
          template
            .replaceAll("@sysroot@", "'/unused-sdk-sysroot'")
            .replaceAll("@libdir@", "'/unused-sdk-sysroot/lib/pkgconfig'")
            .replaceAll("@pkgConfig@", "pkg-config"),
        { mode: 0o755 },
      );
    }
    run("cmake", [
      "-S",
      join(source, "dependency-example"),
      "-B",
      join(root, "library"),
      ...configure,
      `-DCMAKE_INSTALL_PREFIX=${join(root, "prefix")}`,
    ]);
    run("cmake", ["--build", join(root, "library")]);
    run("cmake", ["--install", join(root, "library")]);
    run("cmake", [
      "-S",
      join(source, "cmake-example"),
      "-B",
      join(root, "consumer"),
      ...configure,
      "-DSDK_USE_INSTALLED_ANSWER=ON",
      "-DSDK_USE_BUILD_GENERATOR=ON",
      `-DPKG_CONFIG_EXECUTABLE=${pkgConfig}`,
    ]);
    run("cmake", ["--build", join(root, "consumer"), "--verbose"], buildEnvironment);
    assert.match(
      readFileSync(join(root, "consumer/sdk-generated-answer.h"), "utf8"),
      /SDK_GENERATED_ANSWER 42/,
    );
    const installed = join(root, "installed");
    run("cmake", ["--install", join(root, "consumer"), "--strip", "--prefix", installed], {
      STRIP: "/invalid-ambient-strip",
    });
    const binary = join(installed, "bin", toolchain ? "sdk-example.wasm" : "sdk-example");
    const original = join(root, "consumer", toolchain ? "sdk-example.wasm" : "sdk-example");
    assert.ok(
      statSync(binary).size < statSync(original).size,
      "install --strip did not remove debug/symbol data",
    );
    if (toolchain) {
      assert.ok(process.env.SDK_TEST_OUTPUT_DIRECTORY, "target builds require an output directory");
      copyFileSync(binary, join(process.env.SDK_TEST_OUTPUT_DIRECTORY, "sdk-example.wasm"));
    } else {
      const output = run(binary, []).stdout;
      assert.match(output, /CMake SDK: build-machine generator and target consumer verified/);
      assert.match(output, /::vm-test::pass/);
    }
    // A bad native tool must fail rather than silently using the target's AR.
    const badNative = spawnSync(
      "cmake",
      [
        "-S",
        join(source, "cmake-example"),
        "-B",
        join(root, "bad-native-ar"),
        ...configure,
        "-DSDK_USE_BUILD_GENERATOR=ON",
      ],
      { env: { ...env, AR_FOR_BUILD: "/invalid-build-machine-ar" }, encoding: "utf8" },
    );
    assert.notEqual(badNative.status, 0, "invalid build-machine archiver was silently ignored");
    assert.match(badNative.stdout + badNative.stderr, /invalid-build-machine-ar/);
    // Removing private metadata must break linking: this checks that the
    // successful build really depended on --static, not a self-contained archive.
    const pcFile = join(root, "prefix/lib/pkgconfig/sdk-answer.pc");
    writeFileSync(
      pcFile,
      readFileSync(pcFile, "utf8").replace("Libs.private: -lsdk-helper", "Libs.private:"),
    );
    run("cmake", [
      "-S",
      join(source, "cmake-example"),
      "-B",
      join(root, "missing-private"),
      ...configure,
      "-DSDK_USE_INSTALLED_ANSWER=ON",
      `-DPKG_CONFIG_EXECUTABLE=${pkgConfig}`,
    ]);
    const failed = spawnSync("cmake", ["--build", join(root, "missing-private")], {
      env,
      encoding: "utf8",
    });
    assert.notEqual(failed.status, 0, "link without the private dependency unexpectedly succeeded");
    assert.match(failed.stdout + failed.stderr, /sdk_helper/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
