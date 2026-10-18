// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
const template = readFileSync(new URL("./compiler.sh", import.meta.url), "utf8");
const script = template
  .replaceAll("@compiler@", 'bash -c \'printf "%s\\0" "$@"\' compiler')
  .replaceAll("@configArgument@", "'--config=/sdk with spaces/profile.cfg'");
function run(args) {
  return spawnSync("bash", ["-c", script, "sdk", ...args], { encoding: "utf8" });
}
test("implicit host search paths are removed without changing build flags", () => {
  const inspect = template.replaceAll("@compiler@", "env").replaceAll("@configArgument@", "");
  const paths = [
    "CPATH",
    "C_INCLUDE_PATH",
    "CPLUS_INCLUDE_PATH",
    "OBJC_INCLUDE_PATH",
    "LIBRARY_PATH",
  ];
  const flags = {
    CFLAGS: "-O2 -I/explicit-target",
    CXXFLAGS: "-std=c++17",
    LDFLAGS: "-L/explicit-target",
  };
  const result = spawnSync("bash", ["-c", inspect, "sdk"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...Object.fromEntries(paths.map((key) => [key, "/host-poison"])),
      ...flags,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
  for (const key of paths) assert.equal(actual[key], undefined, `${key} must not reach Clang`);
  for (const [key, value] of Object.entries(flags)) assert.equal(actual[key], value);
});
test("link forwards profile and user arguments without splitting", () => {
  const result = run(["input with spaces.o", "-o", "app.wasm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), [
    "--config=/sdk with spaces/profile.cfg",
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
  test(`${flag} delegates phase selection to Clang`, () => {
    const result = run([flag, "source.cc"]);
    assert.equal(result.status, 0, result.stderr);
    const args = result.stdout.split("\0").slice(0, -1);
    assert.ok(args.includes("--config=/sdk with spaces/profile.cfg"));
    assert.ok(!args.some((arg) => arg.startsWith("-Wl,")));
    assert.deepEqual(args.slice(-2), [flag, "source.cc"]);
  });
}
test("response files are forwarded unchanged for Clang to expand", () => {
  const result = run(["@flags with spaces.rsp"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), [
    "--config=/sdk with spaces/profile.cfg",
    "@flags with spaces.rsp",
  ]);
});

test("empty arguments and shell metacharacters remain literal compiler arguments", () => {
  const args = [
    "",
    "*.cc",
    "$SDK_TEST_LITERAL",
    "$(false)",
    "a;b",
    "quote'\".cc",
    "line\nbreak.cc",
  ];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), [
    "--config=/sdk with spaces/profile.cfg",
    ...args,
  ]);
});

test("compiler failure preserves its exit status and separate diagnostic streams", () => {
  const failing = template
    .replaceAll(
      "@compiler@",
      `bash -c 'printf "compiler-output\\n"; printf "compiler-error\\n" >&2; exit 42' compiler`,
    )
    .replaceAll("@configArgument@", "'--config=/sdk/profile.cfg'");
  const result = spawnSync("bash", ["-c", failing, "sdk", "bad.cc"], { encoding: "utf8" });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 42);
  assert.equal(result.stdout, "compiler-output\n");
  assert.equal(result.stderr, "compiler-error\n");
});

test("stdin source bytes reach the compiler unchanged", () => {
  const passthrough = template
    .replaceAll("@compiler@", "bash -c 'cat' compiler")
    .replaceAll("@configArgument@", "'--config=/sdk/profile.cfg'");
  const input = Buffer.from("// stdin source\r\nint value = 42;\n");
  const result = spawnSync("bash", ["-c", passthrough, "sdk", "-x", "c", "-"], { input });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout, input);
  assert.equal(result.stderr.length, 0);
});
