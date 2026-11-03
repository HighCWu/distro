// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("native GNU split exercises filters and rejects ordinary splitting in their place", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "split-fork-contract-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = fileURLToPath(new URL("runtime-test.sh", import.meta.url));
  const fake = join(directory, "plain-split");
  writeFileSync(
    fake,
    `#!${process.execPath}
const {spawnSync}=require('node:child_process');
const result=spawnSync('/usr/bin/split',process.argv.slice(2).filter(a=>!a.startsWith('--filter=')),{stdio:'inherit'});
process.exit(result.status??1);
`,
    { mode: 0o755 },
  );
  for (const [mode, program] of [
    ["native", "/usr/bin/split"],
    ["no-filter", fake],
  ]) {
    const result = spawnSync("sh", [input, program], {
      encoding: "utf8",
      env: { ...process.env, SPLIT_NATIVE_TEST: "1" },
      timeout: 15000,
    });
    assert.equal(result.error, undefined);
    if (mode === "native") {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal((result.stdout.match(/::vm-test::pass/g) ?? []).length, 1);
      assert.equal((result.stdout.match(/standard split: .* pass/g) ?? []).length, 4);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stdout, /::vm-test::fail: standard split: first filtered piece/);
      assert.doesNotMatch(result.stdout, /::vm-test::pass/);
    }
  }
});
