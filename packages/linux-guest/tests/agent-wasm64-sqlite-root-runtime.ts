// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runSqliteRootWasm64Suite } from "./agent-wasm64-sqlite-root-suite.ts";

test(
  "runs installed wasm64 SQLite across fresh ext4 root instances",
  { timeout: 180_000 },
  async (t) => {
    const image = process.env.AGENT_WASM64_BOOT_DISK;
    const root = process.env.AGENT_WASM64_ROOTFS;
    assert.ok(image && root, "select matching native boot and SQLite ext4 root disks");
    const result = await runSqliteRootWasm64Suite(
      readFileSync(image),
      readFileSync(root),
      assert,
      (name, body) => t.test(name, body),
      (line) => process.stderr.write(line),
    );
    assert.equal(result.passed.length, 2);
    assert.equal(result.closed, true);
  },
);
