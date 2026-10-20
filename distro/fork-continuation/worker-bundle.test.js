// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBundle } from "./worker-bundle-check.mjs";

test("closed bundle admission rejects changed kernel/entry, external imports and split chunks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worker-bundle-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = join(dir, "original"),
    bundled = join(dir, "bundled");
  for (const root of [original, bundled]) {
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist/index.js"), "original index");
    writeFileSync(join(root, "vmlinux.wasm"), "original kernel");
  }
  writeFileSync(join(original, "dist/worker.js"), "module graph");
  writeFileSync(join(bundled, "dist/worker.js"), "single module");
  const output = { imports: [], entryPoint: "/original/dist/worker.js" };
  const meta = { inputs: { a: {}, b: {} }, outputs: { "dist/worker.js": output } };
  const save = (value) =>
    writeFileSync(join(bundled, "worker-bundle-meta.json"), JSON.stringify(value));
  save(meta);
  checkBundle(original, bundled);
  for (const wrong of [
    { ...meta, outputs: { a: { ...output, imports: [{ path: "external.js" }] } } },
    { ...meta, outputs: { a: output, b: output } },
    { ...meta, outputs: { a: { ...output, entryPoint: "/dist/index.js" } } },
    { ...meta, inputs: { a: {} } },
  ]) {
    save(wrong);
    assert.throws(() => checkBundle(original, bundled));
  }
  save(meta);
  for (const file of ["dist/index.js", "vmlinux.wasm"]) {
    writeFileSync(join(bundled, file), "changed");
    assert.throws(() => checkBundle(original, bundled));
    writeFileSync(
      join(bundled, file),
      file.endsWith("wasm") ? "original kernel" : "original index",
    );
  }
  writeFileSync(join(bundled, "dist/worker.js"), "module graph");
  assert.throws(() => checkBundle(original, bundled));
});
