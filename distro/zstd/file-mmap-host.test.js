// SPDX-License-Identifier: MIT
// Workload checks, NOT Linux/Wasm ABI evidence. The native CLI performs the
// positive mmap operations; the target's capacity ceiling is mocked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const original = readFileSync(new URL("./file-mmap-test.sh", import.meta.url), "utf8");
function run(fault = "", refusal = 'echo "$diagnostic" >&2; return 34', mountStatus = 0) {
  const directory = mkdtempSync(join(tmpdir(), "linux-wasm-zstd-file-"));
  try {
    for (const name of ["snapshot", "ordinary", "tmp", "notices"]) mkdirSync(join(directory, name));
    for (const name of ["LICENSE-BSD", "musl-COPYRIGHT", "compiler-rt-LICENSE.TXT"])
      writeFileSync(join(directory, "notices", name), "host fixture, not license evidence\n");
    for (const size of [65535, 65536, 65537, 131071, 131072, 131073]) {
      for (const mount of ["snapshot", "ordinary"])
        writeFileSync(join(directory, mount, `dictionary-${size}`), Buffer.alloc(size));
    }
    assert.equal(original.split("while :; do :; done").length, 3);
    const source = original
      .replace("export PATH=/bin:/sbin:/usr/bin:/usr/sbin", "")
      .replaceAll("/tmp/", `${directory}/tmp/`)
      .replaceAll("/snapshot", `${directory}/snapshot`)
      .replaceAll("/ordinary", `${directory}/ordinary`)
      .replaceAll("/share/licenses/zstd", `${directory}/notices`)
      .replace("while :; do :; done", "exit 1")
      .replace("while :; do :; done", "exit 0");
    return spawnSync("sh", ["-s"], {
      // All mounts are intercepted; never touch the developer's /dev.
      input: `mount() { return ${mountStatus}; }
      zstd() (
        case "$*" in *--mmap-dict*)
          diagnostic=''
          need_path=false
          for argument in "$@"; do
            if "$need_path"; then dictionary_path=$argument; break; fi
            test "$argument" != -D || need_path=true
          done
          test "$(wc -c <"$dictionary_path")" -le 131072 || diagnostic='Out of memory'
          if test -n "$diagnostic"; then ${refusal}; fi
          ${fault}
          ;;
        esac
        command zstd "$@"
      )\n${source}`,
      encoding: "utf8",
      timeout: 15000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("native forced dictionaries cross-roundtrip all five admitted boundaries", () => {
  const result = run();
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.deepEqual(
    [...result.stdout.matchAll(/immutable forced mapping boundary (\d+) verified/g)].map((match) =>
      Number(match[1]),
    ),
    [65535, 65536, 65537, 131071, 131072],
  );
  assert.match(result.stdout, /immutable mapping ceiling 131073 rejected/);
  assert.deepEqual(
    [...result.stdout.matchAll(/regular forced mapping boundary (\d+) verified/g)].map((m) =>
      Number(m[1]),
    ),
    [65535, 65536, 65537, 131071, 131072],
  );
  assert.match(result.stdout, /snapshot ordinary and mutable private copies verified/);
  assert.match(result.stdout, /::vm-test::pass/);
});

test("device setup failure prevents workload success", () => {
  const result = run("", undefined, 1);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /mounting test devices failed/);
});

for (const [name, fault, failure] of [
  ["compression refusal", "return 34", /forced dictionary compression failed/],
  [
    "ordinary source refusal",
    'case "$dictionary_path" in */ordinary/*) return 34 ;; esac',
    /forced dictionary compression failed/,
  ],
  [
    "mutable source refusal",
    'case "$dictionary_path" in */tmp/dictionary) return 34 ;; esac',
    /forced dictionary compression failed/,
  ],
  [
    "decompression refusal",
    'case " $* " in *" -d "*) return 34 ;; esac',
    /forced dictionary decompression failed/,
  ],
  [
    "corrupt compression",
    'case " $* " in *" -d "*) ;; *) echo corrupt; return 0 ;; esac',
    /malloc cross-decompression failed/,
  ],
  [
    "corrupt decompression",
    'case " $* " in *" -d "*) echo corrupt; return 0 ;; esac',
    /mapped decompression roundtrip differed/,
  ],
]) {
  test(`${name} cannot pass the positive workload`, () => {
    const result = run(fault);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, failure);
    assert.doesNotMatch(result.stdout, /::vm-test::pass/);
  });
}

for (const [name, refusal, failure] of [
  ["silent admission", "return 0", /rejected mapping did not exit 34/],
  ["unrelated error", "return 19", /rejected mapping did not exit 34/],
  ["wrong errno", 'echo "Invalid argument" >&2; return 34', /diagnostic mismatch/],
  ["partial output", 'echo bad; echo "$diagnostic" >&2; return 34', /emitted output/],
  [
    "oversized mutable source admitted",
    'case "$dictionary_path" in */tmp/dictionary) test "$(wc -c <"$dictionary_path")" -ne 131073 || return 0 ;; esac; echo "$diagnostic" >&2; return 34',
    /rejected mapping did not exit 34/,
  ],
]) {
  test(`${name} cannot pass source and capacity refusal checks`, () => {
    const result = run("", refusal);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, failure);
    assert.doesNotMatch(result.stdout, /::vm-test::pass/);
  });
}
