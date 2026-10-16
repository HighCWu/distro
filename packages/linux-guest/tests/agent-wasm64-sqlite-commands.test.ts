// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sqliteWrite, sqliteRead, sqliteExpected } from "./agent-wasm64-sqlite-commands.ts";

for (const mode of ["valid", "missing", "integer", "blob", "rows", "corrupt"] as const) {
  test(`native SQLite CLI command contract rejects invalid readback: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "native-sqlite-"));
    const path = join(directory, "application ' data.sqlite");
    const run = (args: string[]) =>
      spawnSync("sqlite3", args, { encoding: "utf8", timeout: 10000 });
    try {
      if (mode !== "missing") {
        const write = run(["-batch", "-bail", path, sqliteWrite]);
        assert.equal(write.status, 0, write.stderr);
        assert.equal(write.stdout, "delete\n");
        const mutation = {
          integer: "UPDATE t SET n=9007199254740992",
          blob: "UPDATE t SET b=X'00ff2a0081'",
          rows: "INSERT INTO t SELECT * FROM t",
        };
        if (mode === "integer" || mode === "blob" || mode === "rows") {
          const changed = run([path, mutation[mode]]);
          assert.equal(changed.status, 0, changed.stderr);
        }
        if (mode === "corrupt") writeFileSync(path, new Uint8Array(4096).fill(0xa5));
      }
      const read = run(["-batch", "-bail", "-readonly", path, sqliteRead]);
      const accepted = read.status === 0 && read.stdout === sqliteExpected && read.stderr === "";
      assert.equal(accepted, mode === "valid");
      if (mode === "missing") assert.equal(existsSync(path), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
