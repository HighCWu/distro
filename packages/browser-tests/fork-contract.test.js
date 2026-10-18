// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertForkOutput, forkStages } from "./fork-contract.js";

test("fork browser gate requires every real workload stage, not only protocol pass", () => {
  const source = ["runtime.c", "exec-child.c"]
    .map((name) =>
      readFileSync(new URL(`../../distro/fork-continuation/${name}`, import.meta.url), "utf8"),
    )
    .join("\n");
  for (const stage of forkStages) assert.ok(source.includes(`"${stage}"`), stage);
  assert.doesNotThrow(() => assertForkOutput(forkStages.join("\n")));
  for (const missing of forkStages) {
    assert.throws(
      () => assertForkOutput(forkStages.filter((line) => line !== missing).join("\n")),
      /missing stage/,
    );
  }
  assert.throws(
    () => assertForkOutput(`${forkStages.join("\n")}\n::vm-test::fail: late error`),
    /reported failure/,
  );
  assert.throws(() => assertForkOutput(undefined), /missing runtime/);
  assert.throws(
    () => assertForkOutput(forkStages.map((line) => `prefix ${line}`).join("\n")),
    /missing stage/,
  );
});
