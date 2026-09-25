// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { section_properties } from "../src/devicetree.ts";

test("section properties follow the root device-tree cell width", () => {
  const sections = { ".data..percpu": [0x1234, 0x5678] as const };

  assert.deepEqual(section_properties(sections, 1), {
    ".data..percpu": [0x1234, 0x5678],
  });
  assert.deepEqual(section_properties(sections, 2), {
    ".data..percpu": [0x1234n, 0x5678n],
  });
});

test("section properties reject values that cannot be represented exactly", () => {
  assert.throws(
    () => section_properties({ broken: [Number.MAX_SAFE_INTEGER + 1, 1] }, 2),
    /invalid section address/,
  );
  assert.throws(() => section_properties({ broken: [0, -1] }, 1), /invalid section size/);
});
