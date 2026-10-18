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

test("optional browser profile selects the Python root and enables only explicit Python import", () => {
  const source = readFileSync(new URL("../wasm64-example/package.nix", import.meta.url), "utf8");
  const html = readFileSync(
    new URL("../../apps/wasm64-example/index.html", import.meta.url),
    "utf8",
  );
  assert.match(source, /withPython \? false/);
  assert.match(source, /withGit \? false/);
  assert.match(source, /assert !withGit \|\| withPython;/);
  assert.match(source, /if withGit then\s+guest-agent.nativeWasm64.rootfsPythonGitExt4/);
  assert.match(source, /if withPython then\s+guest-agent.nativeWasm64.rootfsPythonExt4/);
  assert.match(source, /else\s+guest-agent.nativeWasm64.rootfsExt4/);
  assert.match(html, /value="python" disabled/);
  let python = html;
  let replacements = 0;
  for (const [, from, to] of source.matchAll(/--replace-fail '([^']+)'\s*(?:\\\s*)?'([^']+)'/g)) {
    assert.ok(python.includes(from), `profile substitution still matches HTML: ${from}`);
    python = python.replaceAll(from, to);
    replacements++;
  }
  // The two literal replacements are shared. The third now deliberately
  // selects an escaped description by profile; this is a recipe contract,
  // not evaluation of arbitrary Nix or evidence of a browser boot.
  const description = source.match(
    /--replace-fail '([^']+)'\s*\\\s*\$\{pkgs.lib.escapeShellArg \(\s*if withGit then\s*"([^"]+)"\s*else\s*"([^"]+)"\s*\)\}/,
  );
  assert.ok(
    description,
    "conditional description retains shell escaping and both profile branches",
  );
  assert.equal(replacements + 1, 3);
  assert.equal(description[1], "Minimal BusyBox root (64 MiB); Python is not installed.");
  assert.equal(
    description[2],
    "Python + Git root (512 MiB), including standard library, ncurses, OpenSSL and CA certificates.",
  );
  assert.equal(
    description[3],
    "Python root (256 MiB), including standard library, ncurses, OpenSSL and CA certificates.",
  );
  assert.ok(python.includes(description[1]));
  for (const label of [description[2], description[3]]) {
    const selected = python.replaceAll(description[1], label);
    assert.match(selected, /value="python">/);
    assert.match(selected, /accept="\.wasm,\.pyz,/);
    assert.ok(selected.includes(label));
    assert.ok(!selected.includes(description[1]));
  }
  assert.match(html, /Minimal BusyBox root \(64 MiB\); Python is not installed\./);
  const scope = readFileSync(new URL("../default.nix", import.meta.url), "utf8");
  assert.match(
    scope,
    /wasm64-python-example = self.wasm64-example.override \{ withPython = true; \};/,
  );
  assert.match(
    scope,
    /wasm64-python-git-example = self.wasm64-example.override \{\s+withPython = true;\s+withGit = true;\s+\};/,
  );
  const browser = readFileSync(new URL("../npm/browser-tests.nix", import.meta.url), "utf8");
  assert.match(browser, /"wasm64-python-example-chromium" "wasm64-python-example-firefox"/);
  assert.match(browser, /suite = wasm64PythonExampleSuite;/);
  assert.match(
    browser,
    /expectedTests = \[ "runs a Python zip application through standalone browser controls" \];/,
  );
  assert.match(browser, /cp \$\{python-wasm64.applicationExample\}\/application.pyz/);
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
