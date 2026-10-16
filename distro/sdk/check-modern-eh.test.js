// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { checkModernEh } from "./check-modern-eh.mjs";

const assembly =
  ".tagtype __cpp_exception i64\n  try_table (catch_ref __cpp_exception 0)\n  end_try_table\n";
test("standard exception lowering gate accepts reference catches", () => {
  assert.doesNotThrow(() => checkModernEh(assembly));
  assert.doesNotThrow(() =>
    checkModernEh(assembly.replace("catch_ref __cpp_exception", "catch_all_ref")),
  );
});
test("missing handlers, exception references and C++ tags fail the gate", () => {
  for (const text of [
    assembly.replace("try_table (", "block ("),
    assembly.replace("catch_ref", "catch"),
    assembly.replace(".tagtype __cpp_exception i64", ""),
  ])
    assert.throws(() => checkModernEh(text));
});
test("a mixture containing deprecated instructions fails the gate", () => {
  for (const instruction of ["try", "catch", "catch_all", "rethrow", "delegate"])
    assert.throws(() => checkModernEh(`${assembly}\n  ${instruction} 0\n`), /deprecated/);
});
