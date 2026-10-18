// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Python production root selects matching runtime packages, not interpreter fixtures", () => {
  const source = readFileSync(new URL("../guest-agent/native-wasm64.nix", import.meta.url), "utf8");
  const profile = source.match(/rootfsPythonExt4 = rootfsFor "ext4" \{([\s\S]*?)\} "256M";/);
  assert.ok(profile);
  for (const name of ["python", "ncurses", "openssl"]) {
    assert.ok(profile[1].includes(`${name} = ${name}-wasm64;`));
  }
  assert.match(profile[1], /inherit ca-certificates;/);
  assert.match(source, /extraPackages = builtins.attrValues packages;/);
  assert.match(source, /\/\/ packages;/);
  assert.doesNotMatch(
    profile[1],
    /checks|installedTest|test\.sh|applicationExample|buildMaterials/,
  );
  const recipe = readFileSync(new URL("../guest-agent/package.nix", import.meta.url), "utf8");
  const check = recipe.match(
    /checks\.python-root-wasm64 = import \.\/public-wasm64\.nix \{([\s\S]*?)\n  \};/,
  );
  assert.ok(check);
  assert.match(check[1], /kernel = kernel-wasm64;/);
  assert.match(check[1], /runtimeRootfs = nativeWasm64.rootfsPythonExt4;/);
  assert.match(check[1], /python-wasm64.applicationExample/);
  assert.match(check[1], /agent-wasm64-python-root-runtime.ts/);
});

test("Python public root check requires two fresh boots, exact application bytes and runtime licenses", () => {
  const source = readFileSync(
    new URL(
      "../../packages/linux-guest/tests/agent-wasm64-python-root-runtime.ts",
      import.meta.url,
    ),
    "utf8",
  );
  for (const required of [
    '["write", "read"] as const',
    "withPersistentRootMachine(",
    "root.set(data, offset)",
    "flushes > previousFlushes",
    "assert.equal(closed, 2)",
    "struct.calcsize('P') == 8",
    "sys.prefix == '/usr'",
    "ssl.create_default_context()",
    "readline-COPYING",
    "await using child = await agent.exec",
    "input.slice().reverse()",
    "assert.deepEqual(new Uint8Array(stdout), expected)",
    "assert.equal(stderr.byteLength, 0)",
    'await agent.fs.readFile("/root/application.pyz")',
    'error.code === "ENOENT"',
  ])
    assert.ok(source.includes(required), required);
  const resource = readFileSync(
    new URL("./example/sampleapp/payload.txt", import.meta.url),
    "utf8",
  );
  assert.ok(
    source.includes(JSON.stringify(resource)),
    "expected resource matches actual archive input",
  );
});
