// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const template = readFileSync(new URL("./pkg-config.sh", import.meta.url), "utf8");
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
test("pkg-config isolates target metadata and preserves static dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "wasm-sdk-pc-"));
  try {
    const sysroot = join(root, "target");
    const libdir = join(sysroot, "lib/pkgconfig");
    const sharedir = join(sysroot, "share/pkgconfig");
    const hostdir = join(root, "host");
    const extra = join(root, "extra");
    for (const dir of [libdir, sharedir, hostdir, extra]) mkdirSync(dir, { recursive: true });
    const pc = (name, libs = name) =>
      `prefix=/\nName: ${name}\nDescription: SDK test fixture\nVersion: 1.0\nLibs: -L\${prefix}/lib -l${libs}\nLibs.private: -lprivate_dep\nCflags: -I\${prefix}/include/sdk\n`;
    writeFileSync(join(libdir, "sdk.pc"), pc("sdk"));
    writeFileSync(join(hostdir, "sdk.pc"), pc("sdk", "host_poison"));
    writeFileSync(join(hostdir, "host_only.pc"), pc("host_only"));
    writeFileSync(join(sharedir, "shared.pc"), pc("shared"));
    writeFileSync(join(extra, "addon.pc"), pc("addon"));
    writeFileSync(join(libdir, "consumer.pc"), pc("consumer") + "Requires.private: sdk >= 1.0\n");
    writeFileSync(join(libdir, "missing.pc"), pc("missing") + "Requires.private: host_only\n");
    const script = template
      .replaceAll("@sysroot@", quote(sysroot))
      .replaceAll("@libdir@", quote(`${libdir}:${sharedir}`))
      .replaceAll("@pkgConfig@", "pkg-config");
    const run = (args, overrides = {}) =>
      spawnSync("bash", ["-c", script, "sdk", ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          PKG_CONFIG_PATH: hostdir,
          PKG_CONFIG_LIBDIR: hostdir,
          PKG_CONFIG_SYSROOT_DIR: "/wrong",
          WASM_PKG_CONFIG_PATH: "",
          WASM_PKG_CONFIG_SYSROOT_DIR: "",
          ...overrides,
        },
      });
    const flags = run(["--cflags", "--libs", "sdk"]);
    assert.equal(flags.status, 0, flags.stderr);
    assert.ok(flags.stdout.includes(`-I${sysroot}/include/sdk`), flags.stdout);
    assert.ok(flags.stdout.includes(`-L${sysroot}/lib`), flags.stdout);
    assert.ok(flags.stdout.includes("-lprivate_dep"), flags.stdout);
    assert.ok(!flags.stdout.includes("host_poison"), flags.stdout);
    const filtered = run(["--cflags", "--libs", "sdk"], {
      PKG_CONFIG_SYSTEM_INCLUDE_PATH: `${sysroot}/include/sdk:/include/sdk`,
      PKG_CONFIG_SYSTEM_LIBRARY_PATH: `${sysroot}/lib:/lib`,
    });
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.ok(filtered.stdout.includes(`-I${sysroot}/include/sdk`), filtered.stdout);
    assert.ok(filtered.stdout.includes(`-L${sysroot}/lib`), filtered.stdout);
    assert.equal(run(["--exists", "host_only"]).status, 1);
    assert.equal(run(["--exists", "shared"]).status, 0);
    assert.equal(run(["--exists", "addon"]).status, 1);
    assert.equal(run(["--exists", "addon"], { WASM_PKG_CONFIG_PATH: extra }).status, 0);
    assert.equal(run(["--modversion", "sdk"]).stdout.trim(), "1.0");
    const transitive = run(["--libs", "consumer"]);
    assert.equal(transitive.status, 0, transitive.stderr);
    assert.match(transitive.stdout, /-lconsumer\b/);
    assert.match(transitive.stdout, /-lsdk\b/);
    assert.match(transitive.stdout, /-lprivate_dep\b/);
    assert.doesNotMatch(transitive.stdout, /host_poison/);
    assert.notEqual(run(["--libs", "missing"]).status, 0);

    // External target libraries can be staged outside the SDK's own sysroot.
    // The explicit target override must replace, not concatenate, that root.
    const staged = join(root, "staged-target");
    const relocatedFlags = run(["--cflags", "--libs", "addon"], {
      WASM_PKG_CONFIG_PATH: extra,
      WASM_PKG_CONFIG_SYSROOT_DIR: staged,
    });
    assert.equal(relocatedFlags.status, 0, relocatedFlags.stderr);
    assert.ok(!relocatedFlags.stdout.includes(sysroot), relocatedFlags.stdout);
    // Inspect the flags as arguments, as a shell-based build would consume them.
    const parsed = spawnSync("bash", ["-c", `printf '%s\\n' ${relocatedFlags.stdout}`], {
      encoding: "utf8",
    });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.ok(parsed.stdout.split("\n").includes(`-I${staged}/include/sdk`), parsed.stdout);
    assert.ok(parsed.stdout.split("\n").includes(`-L${staged}/lib`), parsed.stdout);
    assert.notEqual(run(["--definitely-invalid-option"]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
