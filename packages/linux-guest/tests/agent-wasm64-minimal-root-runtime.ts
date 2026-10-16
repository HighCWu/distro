// SPDX-License-Identifier: MIT
// Explicit heavy check of the developer root, not the fixture root.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runMinimalRootWasm64Suite } from "./agent-wasm64-minimal-root-suite.ts";

test(
  "boots the native wasm64 minimal system root through the public API",
  { timeout: 120_000 },
  async (t) => {
    const imagePath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    assert.ok(imagePath && rootPath, "select matching native boot and minimal system disks");
    const result = await runMinimalRootWasm64Suite(
      readFileSync(imagePath),
      readFileSync(rootPath),
      assert,
      (name, body) => t.test(name, body),
      (line) => process.stderr.write(line),
    );
    assert.equal(result.passed.length, 4);
    assert.equal(result.closed, true);
  },
);
