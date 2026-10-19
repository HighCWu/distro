// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  copy_fault_test,
  create_copy_fault_plan,
  inject_copy_fault,
  copy_status_words,
  mark_copy_timeout,
  pause_copy_publication,
  acknowledge_copy_timeout,
  join_copy_timeout,
} from "../src/copy-fault.ts";

test("copy fault plan is build-scoped and resets for each machine", () => {
  const first = create_copy_fault_plan(),
    second = create_copy_fault_plan();
  for (const expected of copy_fault_test
    ? ["initialize", "allocate", "timeout", null, null]
    : [null, null]) {
    assert.equal(first(), expected);
    assert.equal(second(), expected);
  }
});

test("default runtime ignores timeout markers without allocating extra control words", () => {
  if (copy_fault_test) return;
  assert.equal(copy_status_words(), 1);
  const status = new Int32Array(new SharedArrayBuffer(4));
  assert.doesNotThrow(() => {
    mark_copy_timeout(status, "timeout");
    pause_copy_publication("timeout", status);
    acknowledge_copy_timeout("timeout", status);
    join_copy_timeout(status);
  });
  assert.equal(Atomics.load(status, 0), 0);
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
