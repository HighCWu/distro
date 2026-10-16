// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const template = readFileSync(new URL("./compiler.sh", import.meta.url), "utf8");
const script = template
  .replaceAll("@compiler@", 'bash -c \'printf "%s\\0" "$@"\' compiler')
  .replaceAll(
    "@compileFlags@",
    "'--target=wasm64-unknown-linux-musl' '--sysroot=/sdk with spaces' '-matomics'",
  )
  .replaceAll("@linkFlags@", "'-Wl,--import-memory' '-Wl,--shared-memory'");
function run(args) {
  return spawnSync("bash", ["-c", script, "sdk", ...args], { encoding: "utf8" });
}
test("link forwards profile and user arguments without splitting", () => {
  const result = run(["input with spaces.o", "-o", "app.wasm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), [
    "--target=wasm64-unknown-linux-musl",
    "--sysroot=/sdk with spaces",
    "-matomics",
    "-Wl,--import-memory",
    "-Wl,--shared-memory",
    "input with spaces.o",
    "-o",
    "app.wasm",
  ]);
});
for (const flag of [
  "-c",
  "-S",
  "-E",
  "-M",
  "-MM",
  "-fsyntax-only",
  "--version",
  "-dumpmachine",
  "-dumpversion",
  "-print-search-dirs",
  "--print-target-triple",
]) {
  test(`${flag} omits executable linker flags`, () => {
    const result = run([flag, "source.cc"]);
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.split("\0").slice(0, -1);
    assert.ok(args.includes("--target=wasm64-unknown-linux-musl"));
    assert.ok(!args.some((arg) => arg.startsWith("-Wl,")));
    assert.deepEqual(args.slice(-2), [flag, "source.cc"]);
  });
}
test("response files fail explicitly instead of guessing the compile phase", () => {
  const result = run(["@flags.rsp"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /response files are not supported/);
});
