// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Git source bundle retains final selected sources, patches, archive tools and verifies both installed programs", () => {
  const recipe = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(recipe, /passthru.sourceBundle = import \.\/source-bundle.nix/);
  assert.match(recipe, /git = finalAttrs.finalPackage;/);
  assert.match(recipe, /source-bundle = finalAttrs.finalPackage.sourceBundle.check;/);
  for (const name of ["zlib", "curl", "openssl"]) {
    assert.ok(recipe.includes(`package = ${name};\n        recipeDirectory = ../${name};`));
  }
  const source = readFileSync(new URL("./source-bundle.nix", import.meta.url), "utf8");
  for (const required of [
    "sourcePath = toString component.package.src;",
    "component.package.patches or [ ]",
    '"${../python/source-bundle.py}"',
    '"${../python/verify-source-bundle.py}"',
    '"${../sdk/LICENSE.MIT}"',
    "--profile git",
    "${git.buildMaterials}",
    "usr/bin/git usr/libexec/git-core/git-remote-http",
    "sha256sum --check ${bundle}/BINARY_SHA256SUMS",
    "verify-source-bundle.py}",
  ])
    assert.ok(source.includes(required), required);
});

test("actual Git source artifact collection checks bytes before and after copying for each width", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const block = workflow.split("      - name: Collect validated selected Git sources\n")[1];
  const body = block
    .split("        run: |\n")[1]
    .split("\n      - name:")[0]
    .replace(/^          /gm, "");
  for (const mode of ["git", "git-wasm64", "changed", "missing", "wrong-check"]) {
    const root = mkdtempSync(join(tmpdir(), "git-source-artifact-"));
    try {
      const bundle = join(root, "bundle"),
        cwd = join(root, "work");
      mkdirSync(bundle);
      mkdirSync(cwd);
      const names = ["git-selected-sources.tar.gz", "README.md", "BINARY_SHA256SUMS"];
      const hashes = names
        .map((name) => {
          // Only test copying/checksum behavior here; Python tests validate archives.
          const bytes = new Uint8Array([0, 1, 255, name.length]);
          writeFileSync(join(bundle, name), bytes);
          return `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`;
        })
        .join("");
      writeFileSync(join(bundle, "SHA256SUMS"), hashes);
      if (mode === "changed") writeFileSync(join(bundle, names[0]), "changed");
      if (mode === "missing") rmSync(join(bundle, "BINARY_SHA256SUMS"));
      const packageName = mode === "git-wasm64" ? "git-wasm64" : "git";
      const fakeNix = `nix() {
        if [ "$1" = eval ] && [ "$2" = --raw ] && [ "$3" = ".#$EXPECTED_PACKAGE.sourceBundle.outPath" ]; then printf '%s\\n' "$TEST_BUNDLE";
        elif [ "$1" = path-info ]; then test -d "$2";
        else return 2; fi
      }\n`;
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", fakeNix + body], {
        cwd,
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          TEST_BUNDLE: bundle,
          EXPECTED_PACKAGE: packageName,
          SOURCE_CHECK:
            mode === "wrong-check" ? "git-check-unknown" : `${packageName}-check-source-bundle`,
        },
      });
      if (mode === "git" || mode === "git-wasm64") {
        assert.equal(result.status, 0, result.stderr);
        for (const name of [...names, "SHA256SUMS"])
          assert.deepEqual(
            readFileSync(join(cwd, "git-selected-sources", name)),
            readFileSync(join(bundle, name)),
          );
      } else assert.notEqual(result.status, 0, mode);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
