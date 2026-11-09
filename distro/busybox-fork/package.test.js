// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const recipe = readFileSync(join(directory, "package.nix"), "utf8");
const configure = readFileSync(join(directory, "configure.sh"), "utf8");

function phase(name) {
  const match = recipe.match(new RegExp(`${name}\\s*=\\s*''([\\s\\S]*?)'';`));
  assert.ok(match, `missing ${name}`);
  return match[1];
}

test("BusyBox fork recipe uses upstream sources and an isolated install prefix", () => {
  assert.match(recipe, /src\s*=\s*pkgs\.busybox\.src\s*;/);
  assert.match(recipe, /patches\s*=\s*pkgs\.busybox\.patches\s*;/);
  assert.doesNotMatch(recipe, /fetchFromGitHub|owner\s*=\s*["']tombl|repo\s*=\s*["']busybox/);

  assert.match(recipe, /wasm-linux-fork-cc/);
  assert.match(recipe, /wasm-linux-fork-finalize/);
  assert.match(recipe, /wasm-linux-cc/);

  const sourceSnapshot =
    /sha256sum\s+shell\/ash\.c\s+libbb\/vfork_daemon_rexec\.c\s*>\s*source-checksum\.sha256/;
  assert.match(phase("postPatch"), sourceSnapshot);
  assert.match(phase("configurePhase"), /sha256sum\s+-c\s+source-checksum\.sha256/);
  const buildPhase = phase("buildPhase");
  const preBuildCheck = buildPhase.indexOf("sha256sum -c source-checksum.sha256");
  const targetBuild = buildPhase.indexOf("busybox_unstripped");
  const postBuildCheck = buildPhase.lastIndexOf("sha256sum -c source-checksum.sha256");
  assert.ok(preBuildCheck >= 0 && preBuildCheck < targetBuild);
  assert.ok(postBuildCheck > targetBuild);
  assert.match(
    buildPhase,
    /node --test \$\{\.\/(?:package\.test\.js|\.)\}(?:\/package\.test\.js)?/,
  );
  assert.doesNotMatch(
    `${recipe}\n${configure}`,
    /(?:sed|perl|python|substituteInPlace)\b[^\n]*(?:shell\/ash\.c|libbb\/vfork_daemon_rexec\.c)/,
  );
  assert.doesNotMatch(configure, /shell\/ash\.c|libbb\/vfork_daemon_rexec\.c/);

  assert.match(
    recipe,
    /sh\s+applets\/install\.sh\s+["']?\$out\/opt\/busybox-fork["']?\s+--symlinks/,
  );
  assert.match(recipe, /opt\/busybox-fork\/bin\/busybox/);
  assert.match(
    recipe,
    /ln\s+-s\s+["']?\.\.\/opt\/busybox-fork\/bin\/busybox["']?\s+["']?\$out\/bin\/busybox-fork/,
  );
  assert.match(recipe, /\$out\/bin\/busybox-fork-helper/);
  assert.doesNotMatch(recipe, /\$out\/bin\/(?:busybox|ash|sh)(?:["'\s]|$)/);
});
