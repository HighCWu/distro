// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = readFileSync(new URL("./language-test.sh", import.meta.url), "utf8");

test("Lua full shared workload runs on a native interpreter and bytecode compiler", () => {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-lua-workload-"));
  try {
    const bin = join(directory, "bin");
    const notices = join(directory, "notices");
    mkdirSync(bin);
    mkdirSync(notices);
    for (const [name, configured] of [
      ["lua", process.env.LUA_HOST_INTERPRETER ?? "lua5.4"],
      ["luac", process.env.LUA_HOST_COMPILER ?? "luac5.4"],
    ]) {
      // Resolve on the original PATH before installing the test-local aliases.
      const found = spawnSync("sh", ["-c", 'command -v "$1"', "sh", configured], {
        encoding: "utf8",
      });
      assert.equal(found.status, 0, `install Lua 5.4 or configure ${name}: ${found.stderr}`);
      symlinkSync(found.stdout.trim(), join(bin, name));
    }
    for (const name of ["lua-readme.html", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"])
      writeFileSync(join(notices, name), `Host fixture notice: ${name}\n`);
    writeFileSync(join(directory, "platform_test.lua"), "return { answer = 42 }\n");
    // Only adapt sandbox paths, command lookup and the PID-1 halt loops. The
    // actual Lua sources, assertions, spawn and luac invocations stay intact.
    const nativeScript = script
      .replace("export PATH=/bin:/sbin:/usr/bin:/usr/sbin", 'export PATH="$LUA_TEST_PATH"')
      .replaceAll("/tmp/", `${directory}/`)
      .replaceAll("/share/licenses/lua/", `${notices}/`)
      .replace(/while :; do :; done\s*$/, "exit 0\n")
      .replace("while :; do :; done", "exit 1");
    const result = spawnSync("sh", ["-eu", "-c", nativeScript], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        LUA_TEST_PATH: `${bin}:${process.env.PATH}`,
        LUA_PATH: `${directory}/?.lua;/usr/share/lua/5.4/?.lua`,
        LUA_CPATH: "/usr/lib/lua/5.4/?.so",
      },
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^::vm-test::pass$/m);
    assert.match(
      result.stdout,
      /Lua: integer64, modules, I\/O, coroutine cleanup, spawn and bytecode roundtrips verified/,
    );
    assert.doesNotMatch(result.stdout, /::vm-test::fail/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Lua wasm64 package explicitly matches all cross-platform dependencies", () => {
  const scope = readFileSync(new URL("../default.nix", import.meta.url), "utf8");
  const override = scope.match(/lua-wasm64 = self\.lua\.override \{([\s\S]*?)\n    \};/);
  assert.ok(override);
  for (const name of ["stdenv", "platform", "musl", "llvm-runtimes", "busybox", "sdk"])
    assert.ok(override[1].includes(`${name} = self.${name}-wasm64;`), name);
  assert.match(override[1], /vm-test = vmTestWasm64;/);
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /for program in src\/lua src\/luac;/);
  assert.match(recipe, /runHook postBuild/);
  assert.ok(recipe.includes("cp doc/readme.html $out/share/licenses/lua/lua-readme.html"));
  assert.ok(recipe.includes('"/usr/share/lua/5.4/platform_test.lua"'));
  assert.match(recipe, /language = check "language" \.\/language-test\.sh;/);
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});
