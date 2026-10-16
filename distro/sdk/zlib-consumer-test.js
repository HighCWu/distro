// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("SDK builds upstream zlib and consumes its installed pkg-config metadata", () => {
  assert.ok(
    process.env.SDK_TEST_ZLIB_SOURCE,
    "set SDK_TEST_ZLIB_SOURCE to the pinned unpacked zlib source",
  );
  const zlibSource = resolve(process.env.SDK_TEST_ZLIB_SOURCE);
  const source = dirname(fileURLToPath(import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "sdk-zlib-"));
  const prefix = join(root, "prefix");
  const toolchain = process.env.SDK_TEST_CMAKE_TOOLCHAIN;
  const env = {
    ...process.env,
    WASM_PKG_CONFIG_PATH: join(prefix, "lib/pkgconfig"),
    WASM_PKG_CONFIG_SYSROOT_DIR: "/",
  };
  const run = (command, args, cwd = root) => {
    const result = spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(
      result.status,
      0,
      `${command}: ${result.error || ""}\n${result.stdout}\n${result.stderr}`,
    );
    return result;
  };
  try {
    let pkgConfig = process.env.SDK_TEST_PKG_CONFIG;
    if (!pkgConfig) {
      assert.ok(!toolchain, "target builds must use the installed SDK pkg-config wrapper");
      pkgConfig = join(root, "wasm-linux-pkg-config");
      writeFileSync(
        pkgConfig,
        "#!/usr/bin/env bash\n" +
          readFileSync(join(source, "pkg-config.sh"), "utf8")
            .replaceAll("@sysroot@", "'/unused-sdk-sysroot'")
            .replaceAll("@libdir@", "'/unused-sdk-sysroot/lib/pkgconfig'")
            .replaceAll("@pkgConfig@", "pkg-config"),
        { mode: 0o755 },
      );
    }
    const build = join(root, "zlib-build");
    mkdirSync(build);
    run("sh", [join(zlibSource, "configure"), "--static", `--prefix=${prefix}`], build);
    run("make", ["-j2", "libz.a"], build);
    run("make", ["install"], build);
    const configure = [
      "-S",
      join(source, "zlib-example"),
      "-B",
      join(root, "consumer"),
      "-G",
      "Ninja",
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_NINJA_FORCE_RESPONSE_FILE=ON",
      `-DCMAKE_STAGING_PREFIX=${prefix}`,
      `-DPKG_CONFIG_EXECUTABLE=${pkgConfig}`,
    ];
    if (toolchain) configure.push(`-DCMAKE_TOOLCHAIN_FILE=${toolchain}`);
    else
      configure.push(
        "-DCMAKE_FIND_ROOT_PATH=/unused-sdk-sysroot",
        "-DCMAKE_FIND_ROOT_PATH_MODE_LIBRARY=ONLY",
      );
    run("cmake", configure);
    run("cmake", ["--build", join(root, "consumer"), "--verbose"]);
    if (toolchain) {
      assert.ok(process.env.SDK_TEST_OUTPUT_DIRECTORY, "target builds require an output directory");
      copyFileSync(
        join(root, "consumer/sdk-zlib.wasm"),
        join(process.env.SDK_TEST_OUTPUT_DIRECTORY, "sdk-zlib.wasm"),
      );
    } else {
      assert.match(run(join(root, "consumer/sdk-zlib"), []).stdout, /::vm-test::pass/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
