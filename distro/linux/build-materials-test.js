// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const recipe = new URL("./package.nix", import.meta.url);
const script = new URL("./build-materials.sh", import.meta.url);
const readme = new URL("./build-materials.README.md", import.meta.url);

for (const failure of [
  "none",
  "missing config",
  "empty GPL",
  "missing exception",
  "different binary",
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
      const built = spawnSync(
        "bash",
        [script.pathname, source, output, recipe.pathname, metadata, readme.pathname],
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
        readFileSync(join(output, "linux-build/build-materials.sh")),
        readFileSync(script),
      );
      const manifest = JSON.parse(
        readFileSync(new URL("../../packages/kernel/package.json", import.meta.url)),
      );
      put(join(output, "package.json"), JSON.stringify(manifest));
      const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", output], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(packed.status, 0, packed.stderr);
      const [tarball] = JSON.parse(packed.stdout);
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
