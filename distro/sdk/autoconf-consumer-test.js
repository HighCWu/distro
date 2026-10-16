// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("Autoconf SDK entry point separates build and host without executing target probes", () => {
  const root = mkdtempSync(join(tmpdir(), "sdk-autoconf-"));
  const source = dirname(fileURLToPath(import.meta.url));
  const installedWrapper = process.env.SDK_TEST_CONFIGURE;
  try {
    const project = join(root, "source");
    const build = join(root, "build");
    cpSync(join(source, "autoconf-example"), project, { recursive: true });
    mkdirSync(build);
    // An inherited host site file must not supply false target capabilities.
    const hostSite = join(root, "host.site");
    writeFileSync(hostSite, "echo HOST_SITE_WAS_LOADED >&2\nexit 93\n");
    const env = {
      ...process.env,
      CONFIG_SITE: hostSite,
      WASM_CONFIG_SITE: "",
      CC_FOR_BUILD: process.env.CC_FOR_BUILD || "cc",
      CFLAGS_FOR_BUILD: "-O2 -Wall -Wextra -Werror",
    };
    const run = (command, args, cwd = build, overrides = {}) => {
      const result = spawnSync(command, args, {
        cwd,
        env: { ...env, ...overrides },
        encoding: "utf8",
      });
      assert.equal(
        result.status,
        0,
        `${command}: ${result.error || ""}\n${result.stdout}\n${result.stderr}`,
      );
      return result;
    };
    run("autoconf", [], project);
    let wrapper = installedWrapper;
    if (!wrapper) {
      wrapper = join(root, "wasm-linux-configure");
      let script = readFileSync(join(source, "configure.sh"), "utf8");
      for (const [key, value] of Object.entries({
        cc: "cc",
        cxx: "c++",
        ar: "ar",
        ranlib: "ranlib",
        nm: "nm",
        pkgConfig: "pkg-config",
        shell: "/bin/bash",
        build: "x86_64-pc-linux-gnu",
        host: "wasm32-unknown-linux-musl",
      })) {
        script = script.replaceAll(`@${key}@`, `'${value}'`);
      }
      writeFileSync(wrapper, "#!/usr/bin/env bash\nset -euo pipefail\n" + script, { mode: 0o755 });
    }
    // Autoconf's generated function probes may use deliberately mismatched
    // prototypes; reserve -Werror for the actual consumer compilation.
    const configured = run(wrapper, [join(project, "configure"), "CFLAGS=-O2 -g"]);
    assert.match(configured.stdout, /SDK runtime probe deferred to the target environment/);
    assert.doesNotMatch(configured.stdout + configured.stderr, /HOST_SITE_WAS_LOADED/);
    run("make", ["-j2", "CFLAGS=-O2 -Wall -Wextra -Werror"]);
    assert.match(readFileSync(join(build, "generated.h"), "utf8"), /SDK_GENERATED_SIZE 64/);
    if (installedWrapper) {
      assert.ok(process.env.SDK_TEST_OUTPUT_DIRECTORY, "target checks require an output directory");
      copyFileSync(
        join(build, "sdk-autoconf"),
        join(process.env.SDK_TEST_OUTPUT_DIRECTORY, "sdk-autoconf.wasm"),
      );
    } else {
      assert.match(run(join(build, "sdk-autoconf"), []).stdout, /::vm-test::pass/);
    }
    const targetSite = join(root, "target.site");
    writeFileSync(targetSite, "echo SDK_EXPLICIT_TARGET_SITE\n");
    mkdirSync(join(root, "with-site"));
    const explicit = run(wrapper, [join(project, "configure")], join(root, "with-site"), {
      WASM_CONFIG_SITE: targetSite,
    });
    assert.match(explicit.stdout, /SDK_EXPLICIT_TARGET_SITE/);
    // A third-party configure script without a cross-compilation fallback must
    // stop, rather than executing the target or silently inventing an answer.
    const unsupported = join(root, "runtime-required");
    mkdirSync(unsupported);
    writeFileSync(
      join(unsupported, "configure.ac"),
      `AC_INIT([sdk-runtime-required], [1.0])
AC_PROG_CC
AC_RUN_IFELSE([AC_LANG_PROGRAM([], [return 0;])],
  [AC_MSG_NOTICE([SDK_UNEXPECTED_RUNTIME_SUCCESS])],
  [AC_MSG_NOTICE([SDK_UNEXPECTED_RUNTIME_FAILURE])])
AC_OUTPUT
`,
    );
    run("autoconf", [], unsupported);
    const rejected = spawnSync(wrapper, [join(unsupported, "configure")], {
      cwd: unsupported,
      env,
      encoding: "utf8",
    });
    assert.equal(rejected.error, undefined);
    assert.notEqual(rejected.status, 0, "configure without a cross fallback unexpectedly passed");
    assert.match(
      rejected.stdout + rejected.stderr,
      /cannot run test program while cross compiling/,
    );
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /SDK_UNEXPECTED_RUNTIME_/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
