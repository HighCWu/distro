// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

export function checkBundle(original, bundled, mode = "bundle") {
  assert.ok(mode === "bundle" || mode === "transform", "unknown experiment mode");
  const meta = JSON.parse(readFileSync(join(bundled, "worker-bundle-meta.json"), "utf8"));
  const outputs = Object.values(meta.outputs);
  assert.equal(outputs.length, 1, "one ESM worker, no split chunks");
  if (mode === "bundle") {
    assert.deepEqual(outputs[0].imports, [], "no external module graph left in worker");
    assert.ok(Object.keys(meta.inputs).length > 1, "must actually bundle dependencies");
  } else {
    assert.equal(Object.keys(meta.inputs).length, 1, "transform must not merge dependencies");
    assert.equal(Object.keys(meta.inputs)[0], outputs[0].entryPoint);
    const dependencies = (root) =>
      new vm.SourceTextModule(readFileSync(join(root, "dist/worker.js"), "utf8"))
        .dependencySpecifiers;
    const before = dependencies(original),
      after = dependencies(bundled);
    assert.ok(before.length > 0, "control must retain its original module graph");
    assert.deepEqual(after, before, "static imports and their order must be unchanged");
    assert.deepEqual(
      outputs[0].imports.map(({ path, kind, external }) => {
        assert.equal(kind, "import-statement");
        assert.equal(external, true);
        return path;
      }),
      before,
      "metadata must account for all unchanged imports",
    );
  }
  assert.ok(outputs[0].entryPoint.endsWith("/dist/worker.js"));
  const walk = (relative = "") => {
    for (const name of readdirSync(join(original, relative))) {
      const file = join(relative, name);
      if (statSync(join(original, file)).isDirectory()) walk(file);
      else if (file !== "dist/worker.js")
        assert.deepEqual(
          readFileSync(join(bundled, file)),
          readFileSync(join(original, file)),
          file,
        );
    }
  };
  walk();
  assert.notDeepEqual(
    readFileSync(join(bundled, "dist/worker.js")),
    readFileSync(join(original, "dist/worker.js")),
    "experiment must differ from baseline",
  );
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  assert.ok(process.argv.length === 4 || process.argv.length === 5);
  const mode = process.argv[4] ?? "bundle";
  checkBundle(resolve(process.argv[2]), resolve(process.argv[3]), mode);
  console.log(
    mode === "bundle"
      ? "worker bundle: closed graph and unchanged package files pass"
      : "worker transform: original imports and unchanged package files pass",
  );
}
