// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runPersistentRootWasm64Suite } from "./agent-wasm64-persistent-root-suite.ts";

test(
  "persists native wasm64 ext4 root data across fresh machines",
  { timeout: 180_000 },
  async (t) => {
    const image = process.env.AGENT_WASM64_BOOT_DISK;
    const root = process.env.AGENT_WASM64_ROOTFS;
    assert.ok(image && root, "select matching native boot and ext4 system disks");
    const result = await runPersistentRootWasm64Suite(
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
