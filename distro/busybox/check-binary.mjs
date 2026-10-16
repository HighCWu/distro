// SPDX-License-Identifier: MIT
// Inspect bytes, not filenames or the build machine's ability to execute Wasm.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [parserPath, binaryPath, bits, maximumBytes, ...extra] = process.argv.slice(2);
assert.ok(
  parserPath &&
    binaryPath &&
    /^(32|64)$/.test(bits ?? "") &&
    /^[1-9][0-9]*$/.test(maximumBytes ?? "") &&
    extra.length === 0,
  "usage: check-binary.mjs <wasm-parser> <binary> <32|64> <maximum-memory-bytes>",
);
const maximum = BigInt(maximumBytes);
assert.equal(maximum % 65536n, 0n, "memory ceiling must be a whole number of Wasm pages");
const { read_wasm_memories, user_memory_import } = await import(pathToFileURL(parserPath).href);
const memories = read_wasm_memories(readFileSync(binaryPath));
const memory = user_memory_import(memories, bits === "64" ? "i64" : "i32");
assert.ok(
  memory,
  `expected exactly one shared wasm${bits} env.memory import and no defined memory`,
);
assert.equal(
  memory.type.maximum * 65536n,
  maximum,
  "declared memory ceiling differs from platform",
);
assert.ok(
  memory.type.minimum <= memory.type.maximum,
  "minimum memory exceeds the declared ceiling",
);
console.log(`Verified wasm${bits} shared env.memory with ${maximum} byte ceiling`);
