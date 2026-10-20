// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export function checkBundle(original, bundled) {
  const meta = JSON.parse(readFileSync(join(bundled, "worker-bundle-meta.json"), "utf8"));
  const outputs = Object.values(meta.outputs);
  assert.equal(outputs.length, 1, "one ESM worker, no split chunks");
  assert.deepEqual(outputs[0].imports, [], "no external module graph left in worker");
  assert.ok(Object.keys(meta.inputs).length > 1, "must actually bundle dependencies");
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
  assert.equal(process.argv.length, 4);
  checkBundle(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log("worker bundle: closed graph and unchanged package files pass");
}
