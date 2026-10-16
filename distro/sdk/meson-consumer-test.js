// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Meson runs build-machine generators without executing target probes", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-meson-"));
  const source = dirname(fileURLToPath(import.meta.url));
  const installedCrossFile = process.env.SDK_TEST_MESON_CROSS_FILE;
  const meson = process.env.SDK_TEST_MESON || "meson";
  const env = {
    ...process.env,
    CC: "/invalid-target-cc",
    CXX: "/invalid-target-cxx",
    CC_FOR_BUILD: process.env.CC_FOR_BUILD || "cc",
    CXX_FOR_BUILD: process.env.CXX_FOR_BUILD || "c++",
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
  try {
    const targetMetadata = join(root, "target-pc");
    const hostMetadata = join(root, "host-pc");
    for (const directory of [targetMetadata, hostMetadata]) mkdirSync(directory);
    const metadata = (marker) =>
      `marker=${marker}\nName: sdk-meson-fixture\nDescription: dependency isolation fixture\nVersion: 1.0\nLibs:\nCflags:\n`;
    writeFileSync(join(targetMetadata, "sdk-meson-fixture.pc"), metadata("target"));
    writeFileSync(join(hostMetadata, "sdk-meson-fixture.pc"), metadata("host"));
    writeFileSync(join(hostMetadata, "sdk-meson-host-only.pc"), metadata("host"));
    env.PKG_CONFIG_PATH = hostMetadata;
    env.PKG_CONFIG_LIBDIR = hostMetadata;
    env.PKG_CONFIG_SYSROOT_DIR = "/invalid-host-sysroot";
    env.WASM_PKG_CONFIG_PATH = targetMetadata;
    env.WASM_PKG_CONFIG_SYSROOT_DIR = "/";
    let crossFile = installedCrossFile;
    if (!crossFile) {
      const pkgConfig = join(root, "target-pkg-config");
      const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
      writeFileSync(
        pkgConfig,
        "#!/usr/bin/env bash\n" +
          readFileSync(join(source, "pkg-config.sh"), "utf8")
            .replaceAll("@sysroot@", "'/'")
            .replaceAll("@libdir@", quote(targetMetadata))
            .replaceAll("@pkgConfig@", "pkg-config"),
        { mode: 0o755 },
      );
      crossFile = join(root, "cross.ini");
      let template = readFileSync(join(source, "linux-wasm.meson.in"), "utf8");
      for (const [key, value] of Object.entries({
        cc: "cc",
        cxx: "c++",
        ar: "ar",
        strip: "strip",
        pkgConfig,
        wasmArch: "wasm32",
        sysroot: "/",
      })) {
        template = template.replaceAll(`@${key}@`, value);
      }
      writeFileSync(crossFile, template);
    }
    const dependencySource = join(root, "dependency-probe");
    mkdirSync(dependencySource);
    writeFileSync(
      join(dependencySource, "meson.build"),
      `
project('sdk-dependency-isolation', 'c')
target = dependency('sdk-meson-fixture', method: 'pkg-config', required: true)
if target.get_variable(pkgconfig: 'marker') != 'target'
  error('Target dependency was replaced by host metadata')
endif
if dependency('sdk-meson-host-only', method: 'pkg-config', required: false).found()
  error('Host-only dependency leaked into the target configuration')
endif
`,
    );
    run(meson, [
      "setup",
      join(root, "dependency-build"),
      dependencySource,
      "--cross-file",
      crossFile,
      "--wrap-mode=nofallback",
    ]);
    if (!installedCrossFile) {
      const unisolated = join(root, "unisolated.ini");
      writeFileSync(
        unisolated,
        readFileSync(crossFile, "utf8").replace(/^pkg-config = .*$/m, "pkg-config = 'pkg-config'"),
      );
      const rejected = spawnSync(
        meson,
        [
          "setup",
          join(root, "unisolated-build"),
          dependencySource,
          "--cross-file",
          unisolated,
          "--wrap-mode=nofallback",
        ],
        { env, encoding: "utf8" },
      );
      assert.notEqual(rejected.status, 0, "unisolated dependency lookup unexpectedly passed");
      assert.match(
        rejected.stdout + rejected.stderr,
        /Target dependency was replaced by host metadata/,
      );
    }
    const build = join(root, "build");
    run(meson, [
      "setup",
      build,
      join(source, "meson-example"),
      "--cross-file",
      crossFile,
      "--buildtype=release",
      "--wrap-mode=nofallback",
    ]);
    run(meson, ["compile", "-C", build]);
    assert.match(readFileSync(join(build, "answer.h"), "utf8"), /SDK_GENERATED_ANSWER 42/);
    const binary = join(build, "sdk-meson.wasm");
    if (installedCrossFile) {
      assert.ok(process.env.SDK_TEST_OUTPUT_DIRECTORY, "target checks require an output directory");
      copyFileSync(binary, join(process.env.SDK_TEST_OUTPUT_DIRECTORY, "sdk-meson.wasm"));
    } else {
      assert.match(run(binary, []).stdout, /::vm-test::pass/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
