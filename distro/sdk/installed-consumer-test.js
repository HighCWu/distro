// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("CMake consumes a separately installed static library through target pkg-config", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-installed-"));
  const source = dirname(fileURLToPath(import.meta.url));
  const toolchain = process.env.SDK_TEST_CMAKE_TOOLCHAIN;
  const env = {
    ...process.env,
    WASM_PKG_CONFIG_PATH: join(root, "prefix/lib/pkgconfig"),
    WASM_PKG_CONFIG_SYSROOT_DIR: "/",
  };
  const run = (command, args) => {
    const result = spawnSync(command, args, { env, encoding: "utf8" });
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
    "-DCMAKE_BUILD_TYPE=Release",
    "-DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON",
  ];
  if (toolchain) configure.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`);
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
      `-DPKG_CONFIG_EXECUTABLE=${pkgConfig}`,
    ]);
    run("cmake", ["--build", join(root, "consumer"), "--verbose"]);
    const binary = join(root, "consumer", toolchain ? "sdk-example.wasm" : "sdk-example");
    if (toolchain) {
      assert.ok(process.env.SDK_TEST_OUTPUT_DIRECTORY, "target builds require an output directory");
      copyFileSync(binary, join(process.env.SDK_TEST_OUTPUT_DIRECTORY, "sdk-example.wasm"));
    } else {
      assert.match(run(binary, []).stdout, /::vm-test::pass/);
    }
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
