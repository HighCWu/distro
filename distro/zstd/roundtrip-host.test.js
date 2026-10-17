// SPDX-License-Identifier: MIT
// Run the installed-system shell assertions against a host CLI. This validates
// the workload and its failure checks, not the Wasm build, mapping ABI or kernel.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const original = readFileSync(new URL("./roundtrip-test.sh", import.meta.url), "utf8");
function run(prefix = "") {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-zstd-workload-"));
  try {
    const notices = join(directory, "notices");
    mkdirSync(notices);
    for (const name of ["LICENSE-BSD", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"])
      writeFileSync(join(notices, name), "host fixture, not a license verification\n");
    assert.equal(original.split("while :; do :; done").length, 3);
    const source = original
      .replace("export PATH=/bin:/sbin:/usr/bin:/usr/sbin", "")
      .replaceAll("/tmp/", `${directory}/`)
      .replaceAll("/share/licenses/zstd", notices)
      .replace("while :; do :; done", "exit 1")
      .replace("while :; do :; done", "exit 0");
    return spawnSync("sh", ["-s"], {
      input: `${prefix}\n${source}`,
      encoding: "utf8",
      timeout: 15000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Zstandard workload roundtrips mapped dictionaries, binary files and pipes", () => {
  const result = run();
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /::vm-test::pass/);
  assert.doesNotMatch(result.stdout, /::vm-test::fail/);
});

test("mapped dictionary failure cannot be mistaken for successful coverage", () => {
  const result = run(`zstd() {
    case "$*" in *--mmap-dict*) return 19 ;; esac
    command zstd "$@"
  }`);
  assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /mapped dictionary compression failed/);
  assert.doesNotMatch(result.stdout, /::vm-test::pass/);
});

test("accepting a truncated stream fails the workload", () => {
  const result = run(`zstd() {
    case "$*" in *data.bad*) return 0 ;; esac
    command zstd "$@"
  }`);
  assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /decompressing a corrupted stream succeeded/);
  assert.doesNotMatch(result.stdout, /::vm-test::pass/);
});
