// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    let crossFile = installedCrossFile;
    if (!crossFile) {
      crossFile = join(root, "cross.ini");
      let template = readFileSync(join(source, "linux-wasm.meson.in"), "utf8");
      for (const [key, value] of Object.entries({
        cc: "cc",
        cxx: "c++",
        ar: "ar",
        strip: "strip",
        pkgConfig: "pkg-config",
        wasmArch: "wasm32",
        sysroot: "/",
      })) {
        template = template.replaceAll(`@${key}@`, value);
      }
      writeFileSync(crossFile, template);
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
