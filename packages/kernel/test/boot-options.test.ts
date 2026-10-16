// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { checked_cpu_count } from "../src/boot-options.ts";

test("CPU requests retain their exact positive uint32 value", () => {
  for (const cpus of [1, 2, 64, 0x7fffffff, 0xffffffff]) {
    assert.equal(checked_cpu_count(cpus), cpus);
  }
});

test("invalid CPU requests cannot truncate or wrap in the device tree", () => {
  for (const cpus of [
    0,
    -0,
    -1,
    0.5,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    0x100000000,
    Number.MAX_SAFE_INTEGER,
    undefined,
    null,
    "2",
    2n,
  ]) {
    assert.throws(() => checked_cpu_count(cpus as number), {
      name: "RangeError",
      message: "cpus must be an integer between 1 and 4294967295",
    });
  }
});
