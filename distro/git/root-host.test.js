// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("optional Git root selects runtime packages without test fixtures", () => {
  const source = readFileSync(new URL("../guest-agent/native-wasm64.nix", import.meta.url), "utf8");
  const profile = source.match(/rootfsGitExt4 = rootfsFor "ext4" \{([\s\S]*?)\} "256M";/);
  assert.ok(profile);
  assert.match(profile[1], /git = git-wasm64;/);
  assert.match(profile[1], /inherit ca-certificates;/);
  assert.doesNotMatch(profile[1], /checks|installedTest|test\.sh|applicationArchive/);
  assert.match(source, /extraPackages = builtins.attrValues packages;/);
  const recipe = readFileSync(new URL("../guest-agent/package.nix", import.meta.url), "utf8");
  const check = recipe.match(
    /checks\.git-root-wasm64 = import \.\/public-wasm64\.nix \{([\s\S]*?)\n  \};/,
  );
  assert.ok(check);
  assert.match(check[1], /kernel = kernel-wasm64;/);
  assert.match(check[1], /runtimeBootDisk = nativeWasm64.bootDisk;/);
  assert.match(check[1], /runtimeRootfs = nativeWasm64.rootfsGitExt4;/);
  assert.match(check[1], /agent-wasm64-git-root-runtime.ts/);
  assert.doesNotMatch(check[1], /applicationArchive|installedTest/);
});

test("public Git root requires fresh instances, persisted bytes, fixture absence and selected notices", () => {
  const source = readFileSync(
    new URL("../../packages/linux-guest/tests/agent-wasm64-git-root-runtime.ts", import.meta.url),
    "utf8",
  );
  for (const required of [
    '["write", "read"] as const',
    "withPersistentRootMachine(",
    "root.set(data, offset)",
    "flushes > previousFlushes",
    "writes > previousWrites",
    "assert.equal(closed, 2)",
    '"/git-runtime-check.sh"',
    '"/git-notice-check.sh"',
    '"/git-address-bits"',
    '"/vm-test-setup-dev-fd"',
    '"/bin/agent-runtime-child"',
    '"/etc/agent-runtime-root"',
    'error.code === "ENOENT"',
    '"sha256sum", "-c", "SHA256SUMS"',
    "sizeof-long: 8",
    "sizeof-size_t: 8",
    "linked/openssl-LICENSE.txt",
    'agent.fs.readFile("/etc/ssl/cert.pem")',
    'verifyGitApplication(agent, "/root", phase, head, assert)',
  ])
    assert.ok(source.includes(required), required);
  const commands = readFileSync(
    new URL("../../packages/linux-guest/tests/agent-wasm64-git-commands.ts", import.meta.url),
    "utf8",
  );
  for (const required of [
    '"--no-local"',
    '"cat-file", "blob"',
    '"fsck", "--strict"',
    '"pack.threads=2"',
    "assert.equal(head, expectedHead)",
  ]) {
    assert.ok(commands.includes(required), required);
  }
});
