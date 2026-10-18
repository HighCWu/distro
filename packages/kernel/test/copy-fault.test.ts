// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { copy_fault_test, create_copy_fault_plan, inject_copy_fault } from "../src/copy-fault.ts";

test("copy fault plan is build-scoped and resets for each machine", () => {
  const first = create_copy_fault_plan(),
    second = create_copy_fault_plan();
  for (const expected of copy_fault_test ? ["initialize", "allocate", null, null] : [null, null]) {
    assert.equal(first(), expected);
    assert.equal(second(), expected);
  }
});

test("only a fault-enabled build throws at the selected copy stage", () => {
  for (const stage of ["initialize", "allocate"] as const) {
    assert.doesNotThrow(() => inject_copy_fault(undefined, stage));
    assert.doesNotThrow(() =>
      inject_copy_fault(stage === "initialize" ? "allocate" : "initialize", stage),
    );
    if (copy_fault_test) assert.throws(() => inject_copy_fault(stage, stage), /injected copy/);
    else assert.doesNotThrow(() => inject_copy_fault(stage, stage));
  }
});
