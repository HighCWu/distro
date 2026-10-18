// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runPythonGitRootWasm64Suite } from "./agent-wasm64-python-git-root-suite.ts";

test(
  "runs Python Git SQLite collaboration across fresh wasm64 roots",
  { timeout: 180_000 },
  async (t) => {
    const bootPath = process.env.AGENT_WASM64_BOOT_DISK;
    const rootPath = process.env.AGENT_WASM64_ROOTFS;
    const examplePath = process.env.AGENT_WASM64_APPLICATION;
    assert.ok(bootPath && rootPath && examplePath);
    const result = await runPythonGitRootWasm64Suite(
      new Uint8Array(readFileSync(bootPath)),
      new Uint8Array(readFileSync(rootPath)),
      new Uint8Array(readFileSync(examplePath)),
      assert,
      async (name, body) => {
        await t.test(name, body);
      },
      (line) => process.stderr.write(line),
    );
    assert.deepEqual(result, {
      passed: [
        "Python Git workspace write through public SDK",
        "Python Git workspace read through public SDK",
      ],
      closed: true,
    });
  },
);
