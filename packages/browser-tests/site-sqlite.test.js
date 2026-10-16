// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sqlitePersistenceCommands } from "./site-sqlite.js";

const shell = (command) => spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: 10000 });

for (const mode of [
  "valid",
  "missing",
  "wrong integer",
  "wrong blob",
  "extra row",
  "missing table",
  "corrupt",
]) {
  test(`site SQLite persistence commands fail closed: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "site-sqlite-"));
    // Exercise shell quoting rather than silently depending on simple paths.
    const path = join(directory, "database ' with spaces.sqlite");
    const commands = sqlitePersistenceCommands(path);
    assert.ok(
      !commands.write.includes("\n") && !commands.read.includes("\n"),
      "terminal commands must be single lines",
    );
    try {
      if (mode !== "missing") {
        const write = shell(commands.write);
        assert.equal(write.status, 0, write.stderr);
        assert.match(write.stdout, /sqlite-persistence-synced/);
      }
      const modifications = {
        "wrong integer": "UPDATE t SET n=9007199254740992",
        "wrong blob": "UPDATE t SET b=X'00ff2a0081'",
        "extra row": "INSERT INTO t SELECT * FROM t",
        "missing table": "DROP TABLE t",
      };
      if (mode in modifications) {
        const modified = spawnSync("sqlite3", [path, modifications[mode]], { encoding: "utf8" });
        assert.equal(modified.status, 0, modified.stderr);
      }
      if (mode === "corrupt") writeFileSync(path, Buffer.alloc(4096, 0xa5));
      const read = shell(commands.read);
      if (mode === "valid") {
        assert.equal(read.status, 0, read.stderr);
        assert.equal(read.stdout, "sqlite-persistence-restored\n");
      } else {
        assert.notEqual(read.status, 0);
        assert.doesNotMatch(read.stdout, /sqlite-persistence-restored/);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
