// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function checkModernEh(assembly) {
  assert.match(assembly, /^\s*try_table\b/m, "standard try_table handler missing");
  assert.match(assembly, /\bcatch(?:_all)?_ref\b/, "exception-reference catch missing");
  assert.match(assembly, /\.tagtype\s+__cpp_exception\b/, "C++ exception tag missing");
  assert.doesNotMatch(
    assembly,
    /^\s*(?:try|catch|catch_all|rethrow|delegate)\b/m,
    "deprecated exception instruction remains in application assembly",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: check-modern-eh.mjs application.s");
  checkModernEh(readFileSync(process.argv[2], "utf8"));
  console.log("Verified standard try_table exception lowering in application assembly");
}
