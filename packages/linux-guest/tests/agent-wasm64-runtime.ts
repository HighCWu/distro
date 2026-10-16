// SPDX-License-Identifier: MIT
// Explicit heavy check: never auto-discovered by the default wasm32 suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runAgentWasm64Suite } from "./agent-wasm64-suite.ts";

test(
  "native wasm64 agent sessions, files and processes on real Linux",
  { timeout: 120_000 },
  async (t) => {
    const path = process.env.AGENT_WASM64_INITRAMFS;
    assert.ok(path, "AGENT_WASM64_INITRAMFS must select the wasm64 fixture");
    await runAgentWasm64Suite(
      readFileSync(path),
      assert,
      (name, body) => t.test(name, body),
      (text) => {
        process.stderr.write(text);
      },
    );
  },
);
