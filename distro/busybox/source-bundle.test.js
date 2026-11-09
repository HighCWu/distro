// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const exporter = new URL("./build-materials.sh", import.meta.url).pathname;
const archiver = new URL("./source-bundle.sh", import.meta.url).pathname;
const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: "utf8", timeout: 5000, ...options });

test("BusyBox source export keeps final configuration separate and archives reproducibly", () => {
  const root = mkdtempSync(join(tmpdir(), "busybox-source-"));
  const source = join(root, "src.[x], with space");
  const materials = join(root, "materials.[y], with space");
  try {
    mkdirSync(source);
    writeFileSync(join(source, "LICENSE"), "upstream BusyBox license\n");
    writeFileSync(join(source, "Makefile"), "all:\n\ttrue\n");
    writeFileSync(join(source, ".config"), "CONFIG_NOMMU=y\nCONFIG_HUSH=y\n");
    writeFileSync(join(source, "shell.c"), "source bytes\n");
    symlinkSync("shell.c", join(source, "shell-link.c"));
    linkSync(join(source, "shell.c"), join(source, "shell-hard.c"));
    const recipe = join(root, "package.nix");
    const metadata = join(root, "build.json");
    const readme = join(root, "README.md");
    writeFileSync(recipe, "{ }: selected recipe\n");
    writeFileSync(metadata, '{"schemaVersion":1,"addressBits":64}\n');
    writeFileSync(readme, "selected materials, not a complete release\n");
    const exported = run("bash", [exporter, source, materials, recipe, metadata, readme]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(
      readFileSync(join(materials, "busybox.config"), "utf8"),
      "CONFIG_NOMMU=y\nCONFIG_HUSH=y\n",
    );
    const checked = spawnSync("sha256sum", ["--check", "SHA256SUMS"], {
      cwd: materials,
      encoding: "utf8",
    });
    assert.equal(checked.status, 0, checked.stderr);
    const archives = [join(root, "first.tar.gz"), join(root, "second.tar.gz")];
    for (const archive of archives) {
      const result = run("bash", [archiver, source, materials, archive]);
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(readFileSync(archives[0]), readFileSync(archives[1]));
    const alias = join(root, "source-alias");
    symlinkSync(source, alias);
    assert.equal(run("bash", [archiver, alias, materials, archives[1]]).status, 0);
    assert.deepEqual(readFileSync(archives[0]), readFileSync(archives[1]));
    const listing = run("tar", ["-tzf", archives[0]]);
    assert.equal(listing.status, 0, listing.stderr);
    for (const member of [
      "busybox/.config",
      "busybox/Makefile",
      "busybox/LICENSE",
      "build-materials/busybox.config",
      "build-materials/package.nix",
      "build-materials/build.json",
    ]) {
      assert.ok(listing.stdout.split("\n").includes(member), member);
    }
    const unpacked = join(root, "unpacked");
    mkdirSync(unpacked);
    assert.equal(run("tar", ["-xzf", archives[0], "-C", unpacked]).status, 0);
    assert.equal(readFileSync(join(unpacked, "busybox/shell-link.c"), "utf8"), "source bytes\n");
    assert.equal(
      statSync(join(unpacked, "busybox/shell.c")).ino,
      statSync(join(unpacked, "busybox/shell-hard.c")).ino,
    );
    writeFileSync(join(materials, "busybox.config"), "tampered\n");
    assert.notEqual(run("bash", [archiver, source, materials, archives[1]]).status, 0);
    rmSync(join(materials, "busybox.config"));
    assert.notEqual(run("bash", [archiver, source, materials, archives[1]]).status, 0);
    rmSync(join(source, ".config"));
    assert.notEqual(
      run("bash", [exporter, source, join(root, "missing"), recipe, metadata, readme]).status,
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the selected hush patch is checksummed, bundled and applies to its source hunk", () => {
  const root = mkdtempSync(join(tmpdir(), "busybox-hush-patch-"));
  const source = join(root, "busybox-source");
  const materials = join(root, "build-materials");
  const patchPath = new URL("./hush-condition-status.patch", import.meta.url).pathname;
  try {
    assert.ok(existsSync(patchPath), "selected root hush patch is present");
    const patchText = readFileSync(patchPath, "utf8");
    const lines = patchText.split("\n");
    const hunkIndex = lines.findIndex((line) => line.startsWith("@@ "));
    assert.notEqual(hunkIndex, -1, "patch contains a unified diff hunk");
    const header = /^@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@/.exec(lines[hunkIndex]);
    assert.ok(header, "patch hunk header is valid");
    const oldLineCount = Number(header[1] ?? 1);
    const originalLines = [];
    const addedLines = [];
    for (const line of lines.slice(hunkIndex + 1)) {
      if (originalLines.length === oldLineCount) break;
      if (line.startsWith(" ")) originalLines.push(line.slice(1));
      else if (line.startsWith("-")) originalLines.push(line.slice(1));
      else if (line.startsWith("+")) addedLines.push(line.slice(1));
    }
    assert.equal(originalLines.length, oldLineCount, "fixture contains the complete original hunk");
    assert.ok(addedLines.length > 0, "patch adds a concrete source change");

    mkdirSync(join(source, "shell"), { recursive: true });
    writeFileSync(join(source, "LICENSE"), "upstream BusyBox license\n");
    writeFileSync(join(source, "Makefile"), "all:\n\ttrue\n");
    writeFileSync(join(source, ".config"), "CONFIG_NOMMU=y\nCONFIG_HUSH=y\n");
    const originalSource = `${originalLines.join("\n")}\n`;
    writeFileSync(join(source, "shell/hush.c"), originalSource);
    const recipe = join(root, "package.nix");
    const metadata = join(root, "build.json");
    const readme = join(root, "README.md");
    writeFileSync(recipe, "{ }: selected recipe\n");
    writeFileSync(metadata, '{"schemaVersion":1,"addressBits":64}\n');
    writeFileSync(readme, "Apply ../build-materials/hush-condition-status.patch\n");

    const exported = run("bash", [
      exporter,
      source,
      materials,
      recipe,
      metadata,
      readme,
      patchPath,
    ]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.deepEqual(
      readFileSync(join(materials, "hush-condition-status.patch")),
      readFileSync(patchPath),
    );
    const sums = readFileSync(join(materials, "SHA256SUMS"), "utf8");
    assert.match(sums, /hush-condition-status\.patch$/m);
    const checksum = spawnSync("sha256sum", ["--check", "SHA256SUMS"], {
      cwd: materials,
      encoding: "utf8",
    });
    assert.equal(checksum.status, 0, checksum.stderr);

    const archive = join(root, "busybox.tar.gz");
    const archived = run("bash", [archiver, source, materials, archive]);
    assert.equal(archived.status, 0, archived.stderr);
    const unpacked = join(root, "unpacked");
    mkdirSync(unpacked);
    assert.equal(run("tar", ["-xzf", archive, "-C", unpacked]).status, 0);
    const extractedSource = join(unpacked, "busybox/shell/hush.c");
    const extractedPatch = join(unpacked, "build-materials/hush-condition-status.patch");
    assert.equal(readFileSync(extractedSource, "utf8"), originalSource);
    assert.deepEqual(readFileSync(extractedPatch), readFileSync(patchPath));

    const applied = run("patch", ["--batch", "--fuzz=0", "-p1"], {
      cwd: join(unpacked, "busybox"),
      input: patchText,
    });
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const patchedSource = readFileSync(extractedSource, "utf8");
    assert.ok(
      patchedSource.includes(addedLines.join("\n")),
      "patch additions appear in extracted source",
    );

    writeFileSync(join(materials, "hush-condition-status.patch"), `${patchText}\n# tampered\n`);
    assert.notEqual(run("bash", [archiver, source, materials, archive]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
