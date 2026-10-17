// SPDX-License-Identifier: MIT
// Run the installed-system shell assertions against a host CLI. This validates
// the workload and its failure checks, not the Wasm build, mapping ABI or kernel.
// Only forced mmap rejection is simulated: the host kernel supports file mmap.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const original = readFileSync(new URL("./roundtrip-test.sh", import.meta.url), "utf8");
function run(
  fault = "",
  mapping = 'echo "zstd: error 34 : Invalid argument" >&2; return 34',
  mountStatus = 0,
) {
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
      // Never mount over the developer's /dev. Only the target test mounts it.
      input: `mount() {
        test "$*" = "-t devtmpfs devtmpfs /dev" || return 99
        return ${mountStatus}
      }
      zstd() {
        case "$*" in *--mmap-dict*) ${mapping} ;; esac
        ${fault}
        command zstd "$@"
      }\n${source}`,
      encoding: "utf8",
      timeout: 15000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Zstandard workload roundtrips malloc dictionaries, binary files and pipes", () => {
  const result = run();
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /::vm-test::pass/);
  assert.match(result.stdout, /malloc dictionaries verified; forced file mapping rejected/);
  assert.doesNotMatch(result.stdout, /::vm-test::fail/);
});

test("missing test devices fails before running the compression workload", () => {
  const result = run("", undefined, 1);
  assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /mounting test devices failed/);
  assert.doesNotMatch(result.stdout, /::vm-test::pass/);
});

test("ordinary dictionary failure cannot be mistaken for successful coverage", () => {
  const result = run(`case "$*" in *'-D '*) return 19 ;; esac`);
  assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /default dictionary compression failed/);
  assert.doesNotMatch(result.stdout, /::vm-test::pass/);
});

for (const [name, mapping, failure] of [
  ["silent mapping fallback", "return 0", /did not return dictionary error 34/],
  ["unrelated mapping failure", "return 19", /did not return dictionary error 34/],
  ["wrong mapping diagnostic", 'echo "missing file" >&2; return 34', /did not report EINVAL/],
  [
    "output after mapping rejection",
    'echo bad; echo "Invalid argument" >&2; return 34',
    /rejected mapping emitted output/,
  ],
]) {
  test(`${name} fails the workload`, () => {
    const result = run("", mapping);
    assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
    assert.match(result.stdout, failure);
    assert.doesNotMatch(result.stdout, /::vm-test::pass/);
  });
}

test("accepting a truncated stream fails the workload", () => {
  const result = run(`case "$*" in *data.bad*) return 0 ;; esac`);
  assert.equal(result.status, 1, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout, /decompressing a corrupted stream succeeded/);
  assert.doesNotMatch(result.stdout, /::vm-test::pass/);
});
