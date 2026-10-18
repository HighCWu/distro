// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Git notice checks do not require hush's unsupported nounset option", () => {
  const checker = read("./notice-check.sh");
  assert.doesNotMatch(checker, /^\s*set\s+[^\n]*-[^\n]*u/m);
  assert.match(checker, /cd \/usr\/share\/licenses\/git \|\| exit 1/);
  assert.match(checker, /test -s SHA256SUMS \|\| exit 1/);
  assert.match(checker, /sha256sum -c SHA256SUMS/);
});

test("Git wasm64 explicitly selects matching libraries, shell and runtime checker", () => {
  const scope = read("../default.nix");
  assert.match(scope, /git = callPackage \.\/git\/package\.nix \{ \};/);
  const override = scope.match(/git-wasm64 = self\.git\.override \{([^}]+)\};/);
  assert.ok(override);
  for (const name of ["stdenv", "platform", "busybox", "zlib", "curl", "openssl"]) {
    assert.ok(override[1].includes(`${name} = self.${name}-wasm64;`), name);
  }
  assert.match(override[1], /vm-test = vmTestWasm64;/);
});

test("Git checks the installed core and HTTP transport against the selected memory ABI", () => {
  const recipe = read("./package.nix");
  assert.match(recipe, /nativeBuildInputs = \[ pkgs\.nodejs \];/);
  assert.match(
    recipe,
    /postInstall = ''[\s\S]*?for program in "\$out\/usr\/bin\/git" "\$out\/usr\/libexec\/git-core\/git-remote-http";/,
  );
  assert.match(
    recipe,
    /node \$\{\.\.\/busybox\/check-binary\.mjs\} \$\{\.\.\/\.\.\/packages\/kernel\/src\/wasm_binary\.ts\} \\\n\s*"\$program" \$\{toString platform\.addressBits\} \$\{toString platform\.maximumMemoryBytes\}/,
  );
  assert.ok(recipe.includes('"NO_MMAP=YesPlease"'));
  assert.ok(recipe.includes("patches = [ ./run-command-posix-spawn.patch ];"));
});

test("both Git widths retain the same installed-system workflow, packing and remote fixtures", () => {
  const recipe = read("./package.nix");
  assert.match(recipe, /vm-test\.installedTest \{/);
  for (const name of ["workflow", "packing", "remote"]) {
    assert.ok(recipe.includes(`${name} = check "${name}" ./${name}-test.sh;`));
    assert.ok(read(`./${name}-test.sh`).includes('echo "::vm-test::pass"'));
  }
  const packing = read("./packing-test.sh");
  for (const operation of ["pack.threads 2", "git repack -ad", "git fsck --strict", "git gc"]) {
    assert.ok(packing.includes(operation));
  }
  const remote = read("./remote-test.sh");
  for (const operation of ["credential-cache", "http://", "git clone"]) {
    assert.ok(remote.includes(operation));
  }
});
