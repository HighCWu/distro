// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Python runtime ABI fixture accepts native width and rejects the opposite width", () => {
  const width = spawnSync("python3", ["-c", 'import struct; print(8 * struct.calcsize("P"))'], {
    encoding: "utf8",
  });
  assert.equal(width.status, 0, width.stderr);
  const bits = Number(width.stdout.trim());
  assert.ok([32, 64].includes(bits));
  const fixture = fileURLToPath(new URL("./abi-test.py", import.meta.url));
  const valid = spawnSync("python3", [fixture, String(bits)], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.match(valid.stdout, new RegExp(`sysconfig match ${bits} bits`));
  const wrong = spawnSync("python3", [fixture, String(bits === 64 ? 32 : 64)], {
    encoding: "utf8",
  });
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr, /AssertionError/);
  assert.doesNotMatch(wrong.stdout, /Python ABI:/);
});

test("full wasm64 Python closure selects only matching target dependencies", () => {
  const scope = readFileSync(new URL("../default.nix", import.meta.url), "utf8");
  const python = scope.match(/python-wasm64 = self\.python\.override \{([\s\S]*?)\n    \};/);
  assert.ok(python);
  for (const name of [
    "stdenv",
    "platform",
    "llvm-toolchain",
    "zlib",
    "bzip2",
    "xz",
    "readline",
    "ncurses",
    "openssl",
    "busybox",
  ])
    assert.ok(python[1].includes(`${name} = self.${name}-wasm64;`), name);
  assert.ok(python[1].includes("sqlite3 = self.sqlite3-wasm64.dev;"));
  assert.match(python[1], /vm-test = vmTestWasm64;/);
  for (const name of ["bzip2", "xz", "ncurses", "readline"]) {
    const dependency = scope.match(
      new RegExp(`${name}-wasm64 = self\\.${name}\\.override \\{([\\s\\S]*?)\\n    \\};`),
    );
    assert.ok(dependency, name);
    assert.match(dependency[1], /stdenv = self\.stdenv-wasm64;/);
    assert.match(dependency[1], /busybox = self\.busybox-wasm64;/);
    assert.match(dependency[1], /vm-test = vmTestWasm64;/);
    if (name === "readline") assert.match(dependency[1], /ncurses = self\.ncurses-wasm64;/);
  }
});

test("both Python runtime checks require actual pointer ABI and the full interpreter suite remains intact", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.ok(
    recipe.includes(
      "python ${toString platform.addressBits} ${toString platform.maximumMemoryBytes}",
    ),
  );
  assert.equal(
    [...recipe.matchAll(/files\."\/python-abi-test\.py" = \.\/abi-test\.py;/g)].length,
    2,
  );
  assert.equal([...recipe.matchAll(/toString platform\.addressBits \+ "\\n"/g)].length, 2);
  assert.ok(recipe.includes("init = ./python-test.sh;"));
  const full = readFileSync(new URL("./python-test.sh", import.meta.url), "utf8");
  assert.match(full, /python3 \/python-abi-test\.py "\$\(cat \/python-address-bits\)"/);
  assert.match(full, /--installed-layout \|\| fail/);
  const mapping = readFileSync(new URL("./mmap-test.sh", import.meta.url), "utf8");
  assert.match(mapping, /--installed-layout &&/);
  for (const feature of [
    "import bz2",
    "import lzma",
    "import sqlite3",
    "import curses",
    "import ssl",
    "ProcessPoolExecutor",
    "MPOK",
  ])
    assert.ok(full.includes(feature), feature);
  assert.match(recipe, /py_cv_module__posixshmem=n\/a/);
  assert.match(recipe, /--with-ensurepip=no/);
  assert.match(recipe, /--without-mimalloc/);
  for (const notice of [
    "python-LICENSE",
    "bzip2-LICENSE",
    "ncurses-COPYING",
    "readline-COPYING",
    "zlib.h",
    "sqlite3.h",
  ])
    assert.ok(recipe.includes(notice) && full.includes(notice), notice);
  assert.ok(recipe.includes('cp ${xz.src}/COPYING* ${xz.src}/AUTHORS "$notices/xz/"'));
  assert.match(full, /missing Python dependency notice/);
});

test("installed layout fixture rejects build prefixes and operational flag leaks", () => {
  const result = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("./layout-test.py", import.meta.url))],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 6 tests/);
  assert.match(result.stderr, /\bOK\b/);
});
