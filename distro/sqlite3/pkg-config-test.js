// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("SQLite static metadata follows a relocated development installation without host fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-dev-"));
  const original = join(root, "original");
  const relocated = join(root, "relocated");
  const empty = join(root, "empty");
  mkdirSync(join(original, "lib/pkgconfig"), { recursive: true });
  mkdirSync(join(original, "include"));
  mkdirSync(empty);
  const source = readFileSync(new URL("./sqlite3.pc.in", import.meta.url), "utf8");
  writeFileSync(
    join(original, "lib/pkgconfig/sqlite3.pc"),
    source.replaceAll("@version@", "3.51.0"),
  );
  const query = (prefix, args) =>
    spawnSync("pkg-config", args, {
      encoding: "utf8",
      env: {
        ...process.env,
        PKG_CONFIG_LIBDIR: empty,
        PKG_CONFIG_PATH: join(prefix, "lib/pkgconfig"),
        PKG_CONFIG_SYSROOT_DIR: "/",
      },
    });
  try {
    for (const prefix of [original, relocated]) {
      if (prefix === relocated) renameSync(original, relocated);
      const version = query(prefix, ["--modversion", "sqlite3"]);
      assert.equal(version.status, 0, version.stderr);
      assert.equal(version.stdout, "3.51.0\n");
      for (const variable of ["libdir", "includedir"]) {
        const result = query(prefix, [`--variable=${variable}`, "sqlite3"]);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          realpathSync(result.stdout.trim()),
          join(prefix, variable === "libdir" ? "lib" : "include"),
        );
      }
      const flags = query(prefix, ["--static", "--cflags", "--libs", "sqlite3"]);
      assert.equal(flags.status, 0, flags.stderr);
      for (const flag of ["-lsqlite3", "-lm", "-pthread"])
        assert.ok(flags.stdout.split(/\s+/).includes(flag));
      assert.ok(flags.stdout.includes(prefix));
      if (prefix === relocated) assert.equal(flags.stdout.includes(original), false);
    }
    unlinkSync(join(relocated, "lib/pkgconfig/sqlite3.pc"));
    assert.notEqual(
      query(relocated, ["--exists", "sqlite3"]).status,
      0,
      "host SQLite must not mask missing target metadata",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
