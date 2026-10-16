// SPDX-License-Identifier: MIT
// Explicit heavy check; not discovered by the default wasm32 test suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runPublicAgentWasm64Suite } from "./agent-wasm64-public-suite.ts";

test(
  "boots native wasm64 through public guestAgent image selection",
  { timeout: 120_000 },
  async (t) => {
    const imagePath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    assert.ok(imagePath && rootPath, "select matching native boot and system disks");
    await runPublicAgentWasm64Suite(
      readFileSync(imagePath),
      readFileSync(rootPath),
      assert,
      (name, body) => t.test(name, body),
      (line) => {
        process.stderr.write(line);
      },
    );
  },
);
