// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("QuickJS shared language fixture retains valid shell and module syntax", () => {
  const script = readFileSync(new URL("./language-test.sh", import.meta.url), "utf8");
  const shell = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(shell.status, 0, shell.stderr);
  const modules = [...script.matchAll(/cat >\/tmp\/[^\n]+ <<'JS'\n([\s\S]*?)\nJS/g)];
  assert.equal(
    modules.length,
    3,
    "worker, language and bytecode-input modules must remain present",
  );
  for (const [, source] of modules) {
    const result = spawnSync(process.execPath, ["--check", "--input-type=module"], {
      input: source,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const license of ["quickjs-LICENSE", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"]) {
    assert.ok(script.includes(license), `runtime must check installed ${license}`);
  }
  assert.match(script, /grep -qx '::qjs::all-pass'/);
  assert.match(
    script,
    /QuickJS: language, file I\/O, spawn, Worker, timers and bytecode generation verified/,
  );
});

test("wasm64 QuickJS uses matching toolchain, dependencies and runtime", () => {
  const scope = readFileSync(new URL("../default.nix", import.meta.url), "utf8");
  const override = scope.match(/quickjs-wasm64 = self\.quickjs\.override \{([\s\S]*?)\n    \};/);
  assert.ok(override, "wasm64 must be an explicit package, not a changed wasm32 default");
  for (const name of ["stdenv", "platform", "musl", "llvm-runtimes", "busybox"]) {
    assert.ok(override[1].includes(`${name} = self.${name}-wasm64;`), name);
  }
  assert.match(override[1], /vm-test = vmTestWasm64;/);
});
