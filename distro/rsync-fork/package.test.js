// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const recipe = readFileSync(join(directory, "package.nix"), "utf8");
const runtime = readFileSync(join(directory, "runtime-test.sh"), "utf8");
const helper = readFileSync(join(directory, "rsync-fork-helper.c"), "utf8");
const nativeReference = readFileSync(join(directory, "native-reference.sh"), "utf8");

function phase(name) {
  const match = recipe.match(new RegExp(`${name}\\s*=\\s*''([\\s\\S]*?)'';`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

test("rsync fork recipe builds the pinned upstream source with automatic fork support", () => {
  assert.match(recipe, /inherit \(pkgs\.rsync\) version src/);
  assert.match(
    recipe,
    /tar -xOf \$\{pkgs\.rsync\.src\} "rsync-\$\{finalAttrs\.version\}\/\$source_file"/,
  );
  assert.match(recipe, /CONFIG_SITE=\$\{sdk-fork-automatic\.configSite\}/);
  assert.match(recipe, /CC=wasm-linux-fork-cc/);
  assert.match(recipe, /AR=llvm-ar RANLIB=llvm-ranlib/);
  assert.match(recipe, /--prefix=\/opt\/rsync-fork/);
  assert.doesNotMatch(recipe, /wasm-linux-fork-finalize|rsync-clone|fork-shim|Dvfork=fork/);

  const configureFlags = recipe.match(/configureFlags = \[([\s\S]*?)\];/);
  assert.ok(configureFlags, "missing configureFlags");
  for (const option of [
    "--disable-acl-support",
    "--disable-lz4",
    "--disable-openssl",
    "--disable-xattr-support",
    "--disable-xxhash",
    "--disable-zstd",
    "--with-included-popt",
    "--with-included-zlib",
  ])
    assert.ok(configureFlags[1].includes(`\"${option}\"`), `missing configure option ${option}`);
  assert.doesNotMatch(configureFlags[1], /"--disable-iconv(?:-open)?"/);

  const build = phase("buildPhase");
  assert.match(build, /node --test \$\{\.\/\.\}\/package\.test\.js/);
  assert.match(build, /sha256sum main\.c pipe\.c util1\.c > process-source\.sha256/);
  assert.match(build, /sha256sum \$\{pkgs\.rsync\.src\} > source-archive\.sha256/);
  assert.match(build, /sha256sum -c source-archive\.sha256/);
  assert.match(build, /make -j"\$NIX_BUILD_CORES" rsync/);
  assert.doesNotMatch(build, /wasm-linux-fork-finalize/);
  assert.match(recipe, /sdk-fork-automatic\.buildMaterials/);
  assert.match(recipe, /cp COPYING \"\$notices\/rsync-COPYING\"/);
  assert.match(recipe, /cp popt\/COPYING \"\$notices\/popt-COPYING\"/);
  assert.match(recipe, /zlib-license-source\.h/);
  assert.match(recipe, /lib\.licenses\.gpl3Plus/);
  assert.match(recipe, /installedTest/);
  assert.equal((recipe.match(/^\s*meta\s*=/gm) ?? []).length, 1);
  assert.match(recipe, /meta\s*=\s*\{[\s\S]*?outputsToInstall\s*=\s*\[\s*"out"\s*\];/);
  assert.doesNotMatch(recipe, /meta\.outputsToInstall/);
});

test("runtime corpus checks local and remote sync semantics and child cleanup", () => {
  assert.doesNotMatch(runtime, /\\\$\{/);
  assert.match(runtime, /local-initial-sync -aH/);
  assert.match(runtime, /remote-initial-sync -aH/);
  assert.match(runtime, /local-delta-update -aH --no-whole-file --stats/);
  assert.match(runtime, /remote-delta-update -aH --no-whole-file --stats/);
  assert.match(runtime, /Literal data: \\\(\[0-9\]\[0-9,\]\*\\\) bytes/);
  assert.match(runtime, /Matched data: \\\(\[0-9\]\[0-9,\]\*\\\) bytes/);
  assert.match(runtime, /assert_tree_matches/);
  assert.match(runtime, /check_remote_children_reaped/);
  assert.match(runtime, /'\(rsync-fork-help\)'/);
  assert.match(runtime, /remote-error-recovery/);
  assert.match(runtime, /remote-recovery/);
  assert.match(runtime, /\[ \"\$failure_status\" -eq 11 \]/);
  assert.match(runtime, /grep -F 'mkdir \"/);
  assert.match(runtime, /failed: No such file or directory/);
  assert.match(runtime, /--rsh=\"\$helper\" --rsync-path=\"\$rsync_program\"/);
});

test("helper and optional native reference use the same real synchronization corpus", () => {
  assert.match(helper, /fork\(\)/);
  assert.match(helper, /prctl\(PR_SET_CHILD_SUBREAPER, 1L, 0L, 0L, 0L\)/);
  assert.match(helper, /waitpid\(child, child_status, WNOHANG\)/);
  assert.match(helper, /clock_gettime\(CLOCK_MONOTONIC/);
  assert.match(helper, /now\.tv_sec \+ 30/);
  assert.match(helper, /terminate_and_reap_rsync_group/);
  assert.match(
    helper,
    /if \(setpgid\(child, child\)[\s\S]*?terminate_and_reap_rsync_group\(child, child, &child_status\);\s*return 125;/,
  );
  assert.match(helper, /kill\(-process_group, SIGTERM\)/);
  assert.match(helper, /kill\(-process_group, SIGKILL\)/);
  assert.doesNotMatch(helper, /waitpid\(child,\s*&child_status,\s*0\)/);
  assert.match(helper, /waitpid\(-1/);
  assert.match(helper, /execv\(argv\[2\], &argv\[2\]\)/);
  assert.match(helper, /SIGKILL/);
  assert.match(nativeReference, /command -v rsync/);
  assert.match(nativeReference, /RSYNC_FORK_PROGRAM=/);
  assert.match(nativeReference, /NATIVE_REFERENCE=1/);
  assert.match(nativeReference, /runtime-test\.sh/);
});
