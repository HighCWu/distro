// SPDX-License-Identifier: MIT
// Verify a trusted, locally built npm archive, not arbitrary downloaded tarballs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [archive, kernel, manifestPath, licensePath, ...extra] = process.argv.slice(2);
assert.ok(
  archive && kernel && manifestPath && licensePath && extra.length === 0,
  "usage: check-kernel-package.mjs ARCHIVE LINUX_OUTPUT SOURCE_MANIFEST HOST_LICENSE",
);
const directory = mkdtempSync(join(tmpdir(), "kernel-package-check-"));
function files(root, relative = "") {
  return readdirSync(join(root, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) return files(root, path);
      assert.ok(entry.isFile(), `unexpected non-regular material: ${path}`);
      return [path];
    })
    .sort();
}
try {
  execFileSync("tar", [
    "-xzf",
    archive,
    "--strip-components=1",
    "--no-same-owner",
    "--no-same-permissions",
    "-C",
    directory,
  ]);
  execFileSync("sha256sum", ["--check", "linux-build/SHA256SUMS"], { cwd: directory });
  const expected = JSON.parse(readFileSync(manifestPath));
  const actual = JSON.parse(readFileSync(join(directory, "package.json")));
  for (const key of ["name", "version", "license"]) assert.equal(actual[key], expected[key], key);
  assert.ok(
    actual.files.includes("linux-build"),
    "published file list must retain build materials",
  );
  assert.deepEqual(
    readFileSync(join(directory, "LICENSE")),
    readFileSync(licensePath),
    "host MIT license must remain unchanged",
  );
  const materialFiles = files(join(kernel, "linux-build"));
  assert.deepEqual(
    files(join(directory, "linux-build")),
    materialFiles,
    "archive must include every build material and original notice",
  );
  for (const path of ["vmlinux.wasm", ...materialFiles.map((path) => join("linux-build", path))]) {
    assert.deepEqual(
      readFileSync(join(directory, path)),
      readFileSync(join(kernel, path)),
      `archive bytes differ from the selected Linux output: ${path}`,
    );
  }
  console.log(
    "Verified npm kernel binary, selected build materials, host license and package declaration",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
