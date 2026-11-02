// SPDX-License-Identifier: MIT
// Validate workload data assertions with native Git, not the Wasm mapping ABI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const original = readFileSync(new URL("./packing-test.sh", import.meta.url), "utf8");
function run(fault = "") {
  const root = mkdtempSync(join(tmpdir(), "linux-wasm-git-packing-"));
  try {
    const templates = join(root, "templates");
    mkdirSync(templates);
    assert.equal(original.split("while :; do :; done").length, 3);
    assert.ok(original.includes("/bin/sh /git-runtime-check.sh"));
    const source = original
      .replaceAll("/tmp", root)
      .replaceAll("/root", join(root, "home"))
      .replace("/bin/sh /git-runtime-check.sh", ":")
      .replace("while :; do :; done", "exit 1")
      .replace("while :; do :; done", "exit 0");
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TEMPLATE_DIR: templates,
    });
    return spawnSync("sh", ["-s"], {
      cwd: root,
      env,
      input: `mount() { test "$*" = '-t devtmpfs devtmpfs /dev'; }
git() {
  if test "$*" = --exec-path; then printf '%s\\n' /usr/libexec/git-core; return; fi
  ${fault}
  command git "$@"
}
${source}`,
      encoding: "utf8",
      timeout: 60000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("packing workload roundtrips a real binary pack across bounded windows", () => {
  const result = run();
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /binary windows, object roundtrip, threaded repack/);
  assert.match(result.stdout, /::vm-test::pass/);
});

test("successful cat-file with corrupt bytes cannot pass packing coverage", () => {
  const result = run(
    `if test "$1" = cat-file && test "$2" = blob; then echo corrupt; return 0; fi`,
  );
  assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /packed binary window data differed/);
  assert.doesNotMatch(result.stdout, /::vm-test::pass/);
});
