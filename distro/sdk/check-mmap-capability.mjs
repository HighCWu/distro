// SPDX-License-Identifier: MIT
// Inspect the final module, never infer a capability from compiler arguments.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [binary, expected, profile, ...extra] = process.argv.slice(2);
assert.ok(
  binary && ["present", "absent"].includes(expected) && extra.length === 0,
  "usage: check-mmap-capability.mjs <module> <present|absent> [sdk-profile.json]",
);
const module = new WebAssembly.Module(readFileSync(binary));
const exports = WebAssembly.Module.exports(module).filter(
  (item) => item.name === "__wasm_mmap_init_v1",
);
const imports = WebAssembly.Module.imports(module).filter(
  (item) => item.module === "linux_mmap_init_v1" && item.name === "copy",
);
if (expected === "present") {
  assert.deepEqual(exports, [{ name: "__wasm_mmap_init_v1", kind: "function" }]);
  assert.deepEqual(imports, [{ module: "linux_mmap_init_v1", name: "copy", kind: "function" }]);
} else {
  assert.deepEqual(exports, [], "old-module control must not expose the initialized allocator");
  assert.deepEqual(imports, [], "old-module control must not require the new copy import");
}
if (profile) {
  assert.equal(expected, "present", "ordinary SDK metadata cannot describe an old-module fixture");
  const metadata = JSON.parse(readFileSync(profile, "utf8"));
  assert.deepEqual(metadata.execution.initializedPrivateCopy, {
    version: 1,
    exportName: "__wasm_mmap_init_v1",
    importModule: "linux_mmap_init_v1",
    importName: "copy",
    requiresKernelExport: "abort_file_mmap_v1",
    admission: "kernel",
  });
  assert.ok(metadata.linkerFlags.includes("--export=__wasm_mmap_init_v1"));
}
console.log(`Verified initialized private-copy execution capability ${expected}`);
