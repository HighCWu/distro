// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

const recipe = new URL("./package.nix", import.meta.url);
const fetchRecipe = new URL("./fetch-source.nix", import.meta.url);
const script = new URL("./build-materials.sh", import.meta.url);
const readme = new URL("./build-materials.README.md", import.meta.url);

for (const failure of [
  "none",
  "missing config",
  "empty GPL",
  "missing exception",
  "different binary",
  "empty fetch recipe",
]) {
  test(`kernel build materials use exact compiled inputs and fail closed: ${failure}`, () => {
    const root = mkdtempSync(join(tmpdir(), "kernel-materials-"));
    const source = join(root, "build");
    const output = join(root, "out");
    const put = (path, contents) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    };
    try {
      const originals = {
        ".config": "CONFIG_MMU=n\nCONFIG_64BIT=y\n",
        COPYING: "Original Linux COPYING fixture\n",
        "LICENSES/preferred/GPL-2.0": "Original GPL fixture\n",
        "LICENSES/exceptions/Linux-syscall-note": "Original exception fixture\n",
        "LICENSES/other/example": "Additional unchanged notice\n",
        "vmlinux.wasm": Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
      };
      for (const [path, contents] of Object.entries(originals)) put(join(source, path), contents);
      put(join(output, "vmlinux.wasm"), originals["vmlinux.wasm"]);
      const metadata = join(root, "metadata.json");
      put(metadata, JSON.stringify({ schemaVersion: 1, wasmBits: 64 }));
      if (failure === "missing config") rmSync(join(source, ".config"));
      if (failure === "empty GPL") put(join(source, "LICENSES/preferred/GPL-2.0"), "");
      if (failure === "missing exception")
        rmSync(join(source, "LICENSES/exceptions/Linux-syscall-note"));
      if (failure === "different binary") put(join(output, "vmlinux.wasm"), "wrong binary");
      const selectedFetchRecipe =
        failure === "empty fetch recipe" ? join(root, "empty.nix") : fetchRecipe.pathname;
      if (failure === "empty fetch recipe") put(selectedFetchRecipe, "");
      const built = spawnSync(
        "bash",
        [
          script.pathname,
          source,
          output,
          recipe.pathname,
          metadata,
          readme.pathname,
          selectedFetchRecipe,
        ],
        { encoding: "utf8" },
      );
      if (failure !== "none") {
        assert.notEqual(built.status, 0);
        return;
      }
      assert.equal(built.status, 0, built.stderr);
      for (const [path, contents] of Object.entries(originals)) {
        const destination =
          path === "vmlinux.wasm"
            ? path
            : `linux-build/${path === ".config" ? "kernel.config" : path}`;
        assert.deepEqual(readFileSync(join(output, destination)), Buffer.from(contents));
      }
      assert.deepEqual(readFileSync(join(output, "linux-build/package.nix")), readFileSync(recipe));
      assert.deepEqual(
        readFileSync(join(output, "linux-build/fetch-source.nix")),
        readFileSync(fetchRecipe),
      );
      assert.deepEqual(
        readFileSync(join(output, "linux-build/build-materials.sh")),
        readFileSync(script),
      );
      const manifest = JSON.parse(
        readFileSync(new URL("../../packages/kernel/package.json", import.meta.url)),
      );
      put(join(output, "package.json"), JSON.stringify(manifest));
      const license = new URL("../../packages/kernel/LICENSE", import.meta.url);
      const manifestPath = new URL("../../packages/kernel/package.json", import.meta.url);
      const checker = new URL("../npm/check-kernel-package.mjs", import.meta.url);
      put(join(output, "LICENSE"), readFileSync(license));
      const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", output], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(packed.status, 0, packed.stderr);
      const [tarball] = JSON.parse(packed.stdout);
      const verify = (archive) =>
        spawnSync(
          process.execPath,
          [checker.pathname, archive, output, manifestPath.pathname, license.pathname],
          { encoding: "utf8" },
        );
      const verified = verify(join(root, tarball.filename));
      assert.equal(verified.status, 0, verified.stderr);
      const extracted = join(root, "extracted");
      mkdirSync(extracted);
      assert.equal(
        spawnSync("tar", [
          "-xzf",
          join(root, tarball.filename),
          "--strip-components=1",
          "-C",
          extracted,
        ]).status,
        0,
      );
      assert.equal(
        spawnSync("sha256sum", ["--check", "linux-build/SHA256SUMS"], { cwd: extracted }).status,
        0,
      );
      put(join(extracted, "linux-build/kernel.config"), "tampered\n");
      assert.notEqual(
        spawnSync("sha256sum", ["--check", "linux-build/SHA256SUMS"], { cwd: extracted }).status,
        0,
      );
      // Rehashing a substituted configuration must not fool the archive-level
      // comparison against the selected Linux output.
      const sumsPath = join(extracted, "linux-build/SHA256SUMS");
      const hash = createHash("sha256").update("tampered\n").digest("hex");
      put(
        sumsPath,
        readFileSync(sumsPath, "utf8").replace(
          /^\w+  linux-build\/kernel.config$/m,
          `${hash}  linux-build/kernel.config`,
        ),
      );
      const modifiedArchive = join(root, "modified.tgz");
      const repack = () => {
        assert.equal(
          spawnSync("tar", ["-czf", modifiedArchive, "-C", root, "extracted"]).status,
          0,
        );
        return verify(modifiedArchive);
      };
      const substituted = repack();
      assert.notEqual(substituted.status, 0);
      assert.match(substituted.stderr, /archive bytes differ/);
      put(join(extracted, "linux-build/kernel.config"), originals[".config"]);
      put(sumsPath, readFileSync(join(output, "linux-build/SHA256SUMS")));
      put(join(extracted, "LICENSE"), "wrong host license\n");
      const wrongLicense = repack();
      assert.notEqual(wrongLicense.status, 0);
      assert.match(wrongLicense.stderr, /host MIT license must remain unchanged/);
      put(join(extracted, "LICENSE"), readFileSync(license));
      put(join(extracted, "package.json"), JSON.stringify({ ...manifest, license: "MIT" }));
      const relicensed = repack();
      assert.notEqual(relicensed.status, 0);
      assert.match(relicensed.stderr, /license/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
