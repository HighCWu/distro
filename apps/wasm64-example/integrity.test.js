// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundleManifest, verifyBundle } from "./integrity.mjs";

test("complete bundle inventory survives relocation and detects changed payloads", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "wasm64-example-integrity-"));
  try {
    const original = join(temporary, "original");
    const relocated = join(temporary, "relocated");
    await mkdir(join(original, "node_modules/kernel"), { recursive: true });
    await writeFile(join(original, "root.ext4"), new Uint8Array([0, 255, 128, 0]));
    await writeFile(join(original, "node_modules/kernel/module.wasm"), "kernel fixture");
    await copyFile(new URL("./integrity.mjs", import.meta.url), join(original, "integrity.mjs"));
    const run = (...args) => spawnSync(process.execPath, args, { encoding: "utf8" });
    const written = run(join(original, "integrity.mjs"), "--write");
    assert.equal(written.status, 0, written.stderr);
    assert.notEqual(run(join(original, "integrity.mjs"), "--write").status, 0);
    await cp(original, relocated, { recursive: true });
    await rm(original, { recursive: true });
    assert.equal(await verifyBundle(relocated), 3);
    const checked = run(join(relocated, "integrity.mjs"));
    assert.equal(checked.status, 0, checked.stderr);
    assert.match(checked.stdout, /Verified 3 bundle files/);
    // Nix's usual result directory is a symlink. Node resolves import.meta.url
    // but preserves the argv entry path; the CLI must not silently skip work.
    const resultLink = join(temporary, "result");
    await symlink(relocated, resultLink);
    const linked = run(join(resultLink, "integrity.mjs"));
    assert.equal(linked.status, 0, linked.stderr);
    assert.match(linked.stdout, /Verified 3 bundle files/);
    const path = join(relocated, "root.ext4");
    const saved = await readFile(path);
    await writeFile(path, new Uint8Array([0, 255, 129, 0]));
    await assert.rejects(verifyBundle(relocated), /integrity mismatch/);
    assert.notEqual(run(join(relocated, "integrity.mjs")).status, 0);
    await writeFile(path, saved);
    await unlink(path);
    await assert.rejects(verifyBundle(relocated), /integrity mismatch/);
    await writeFile(path, saved);
    await writeFile(join(relocated, "unexpected.js"), "stale output");
    await assert.rejects(verifyBundle(relocated), /integrity mismatch/);
    await unlink(join(relocated, "unexpected.js"));
    await symlink(path, join(relocated, "external-link"));
    await assert.rejects(verifyBundle(relocated), /symbolic link/);
    await unlink(join(relocated, "external-link"));
    await writeFile(join(relocated, "checksums.json"), "{}");
    await assert.rejects(verifyBundle(relocated), /integrity mismatch/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("manifest ordering and hashes do not depend on the installation prefix", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "wasm64-manifest-"));
  try {
    await writeFile(join(temporary, "b"), "b");
    await writeFile(join(temporary, "a"), "a");
    const manifest = await bundleManifest(temporary);
    assert.deepEqual(
      manifest.files.map((entry) => entry.path),
      ["a", "b"],
    );
    assert.equal(manifest.files[0].size, 1);
    assert.equal(
      manifest.files[0].sha256,
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
    assert.equal(JSON.stringify(manifest).includes(temporary), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
