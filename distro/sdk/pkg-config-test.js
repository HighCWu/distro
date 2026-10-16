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
    assert.equal(run(["--exists", "host_only"]).status, 1);
    assert.equal(run(["--exists", "shared"]).status, 0);
    assert.equal(run(["--exists", "addon"]).status, 1);
    assert.equal(run(["--exists", "addon"], { WASM_PKG_CONFIG_PATH: extra }).status, 0);
    assert.equal(run(["--modversion", "sdk"]).stdout.trim(), "1.0");
    assert.notEqual(run(["--definitely-invalid-option"]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
