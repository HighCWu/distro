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

test("both installed Python systems include OpenSSL's certificate package dependency", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  const checks = recipe.slice(recipe.indexOf("passthru.checks = {"));
  const systems = [...checks.matchAll(/contents = \[([\s\S]*?)\];/g)];
  assert.equal(systems.length, 2);
  for (const [, contents] of systems) {
    const packages = contents.trim().split(/\s+/);
    for (const name of [
      "busybox",
      "ca-certificates",
      "ncurses",
      "openssl",
      "finalAttrs.finalPackage",
    ])
      assert.ok(packages.includes(name), `missing installed-system dependency: ${name}`);
  }
  const openssl = readFileSync(new URL("../openssl/package.nix", import.meta.url), "utf8");
  assert.match(openssl, /passthru\.apk\.depends[\s\S]*?"ca-certificates"/);
});

test("relocated compressed Python application runs without its original source tree", () => {
  const result = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("./application-test.py", import.meta.url))],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /relocated compressed archive, metadata, resources and binary pipes verified/,
  );
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.ok(recipe.includes('files."/python-application-test.py" = ./application-test.py;'));
  const script = readFileSync(new URL("./python-test.sh", import.meta.url), "utf8");
  assert.match(
    script,
    /python3 \/python-application-test\.py --example \/python-example\.pyz \|\| fail/,
  );
});

test("published Python example is reproducible, relocatable and retains package metadata", () => {
  const result = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("./example-host-test.py", import.meta.url))],
    { encoding: "utf8", timeout: 20_000 },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /passthru\.applicationExample = applicationExample/);
  assert.ok(
    recipe.includes('files."/python-example.pyz" = "${applicationExample}/application.pyz";'),
  );
  assert.ok(
    recipe.includes(
      "${pkgs.python313}/bin/python3 $out/source/build-example.py $out/application.pyz",
    ),
  );
});

test("fork-less PATH fallback preserves error precedence and caller executable names", () => {
  const result = spawnSync(
    "python3",
    ["-B", fileURLToPath(new URL("./spawn-errors-test.py", import.meta.url)), "--patch-logic"],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.equal((result.stdout.match(/PATH error precedence/g) || []).length, 2);
  assert.match(
    result.stdout,
    /repeated failed launches preserve parent fds, CLOEXEC and child cleanup/,
  );
  assert.match(result.stdout, /injected native fd and CLOEXEC leaks rejected/);
  assert.match(result.stdout, /descriptor exhaustion preserves parent fds and child cleanup/);
  assert.match(result.stdout, /injected descriptor exhaustion leak rejected/);
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.ok(recipe.includes('files."/python-spawn-errors-test.py" = ./spawn-errors-test.py;'));
  const script = readFileSync(new URL("./python-test.sh", import.meta.url), "utf8");
  assert.match(script, /python3 \/python-spawn-errors-test\.py \|\| fail/);
});

test("Python process timeouts preserve binary pipes and terminated children are reaped", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      fileURLToPath(new URL("./process-lifecycle-test.py", import.meta.url)),
      "--native-controls",
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stdout,
    /timeout recovery, binary pipes, terminate, kill and reaping verified/,
  );
  assert.match(result.stdout, /injected retry output duplication rejected/);
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.ok(
    recipe.includes('files."/python-process-lifecycle-test.py" = ./process-lifecycle-test.py;'),
  );
  const script = readFileSync(new URL("./python-test.sh", import.meta.url), "utf8");
  assert.match(script, /python3 \/python-process-lifecycle-test\.py \|\| fail/);
});
