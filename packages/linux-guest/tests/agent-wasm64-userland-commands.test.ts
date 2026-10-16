// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  publicAbortScript,
  publicChildStatusScript,
  publicShellScript,
  publicStreamScript,
} from "./agent-wasm64-userland-commands.ts";

test("public userland scripts retain fail-fast checks without unsupported hush nounset", () => {
  for (const script of [publicShellScript, publicStreamScript, publicAbortScript]) {
    assert.equal(script.trimStart().split("\n")[0], "set -e");
    const syntax = spawnSync("/bin/sh", ["-n", "-c", script], { encoding: "utf8" });
    assert.ifError(syntax.error);
    assert.equal(syntax.status, 0, syntax.stderr);
  }
  assert.ok(publicShellScript.includes('[ "$PWD" = /tmp ]'));
  assert.ok(publicShellScript.includes("[ \"$1\" = 'public shell arg' ]"));
  assert.ok(publicShellScript.includes("[ \"$AGENT_RUNTIME_VALUE\" = 'public shell env' ]"));
});

test("public shell captures the exact child exit status before conditional branches", () => {
  const run = (script: string) =>
    spawnSync(
      "/bin/sh",
      [
        "-c",
        String.raw`
set -e
fail() { printf '%s [%s]\n' "$1" "$2" >&2; exit 1; }
${script}
printf '%s\n' "$status"
`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  assert.ok(publicShellScript.includes(publicChildStatusScript));
  const expected = run(publicChildStatusScript);
  assert.ifError(expected.error);
  assert.equal(expected.status, 0, expected.stderr);
  assert.equal(expected.stdout, "7\n");
  assert.equal(expected.stderr, "");
  // A successful child or a different nonzero status must still fail.
  for (const status of [0, 23]) {
    const unexpected = run(publicChildStatusScript.replace("exit 7", `exit ${status}`));
    assert.ifError(unexpected.error);
    assert.equal(unexpected.status, 1);
    assert.equal(unexpected.stdout, "");
    assert.equal(unexpected.stderr, `child-status [${status}]\n`);
  }
});

test("public binary pipeline script preserves bytes, separates streams and removes its copy on the host", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-userland-commands-"));
  try {
    const payload = Uint8Array.from({ length: 256 * 1024 + 17 }, (_, i) => (i * 37 + 11) & 255);
    const result = spawnSync("/bin/sh", ["-c", publicStreamScript], {
      cwd: directory,
      env: { ...process.env, TMPDIR: directory },
      input: payload,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 5000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.deepEqual(new Uint8Array(result.stdout), payload);
    assert.deepEqual(new Uint8Array(result.stderr), payload);
    assert.equal(existsSync(join(directory, "public-stream-copy")), false);

    const missingDirectory = spawnSync("/bin/sh", ["-c", publicStreamScript], {
      cwd: directory,
      env: { ...process.env, TMPDIR: "" },
      timeout: 5000,
    });
    assert.ifError(missingDirectory.error);
    assert.equal(missingDirectory.status, 1);

    // Fail at the first assertion before touching any fixed runtime paths.
    const wrongCwd = spawnSync(
      "/bin/sh",
      ["-c", publicShellScript, "agent-shell", "public shell arg"],
      {
        cwd: directory,
        env: { ...process.env, AGENT_RUNTIME_VALUE: "public shell env" },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(wrongCwd.error);
    assert.equal(wrongCwd.status, 1);
    assert.equal(wrongCwd.stdout, "");
    assert.equal(wrongCwd.stderr, `public shell check failed: cwd [${directory}]\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
