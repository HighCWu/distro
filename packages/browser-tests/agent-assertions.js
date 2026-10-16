// SPDX-License-Identifier: MIT
// Small assertion adapter for the shared runtime corpus. It compares only the
// scalar, Uint8Array and plain-record values used by those checks.
function same(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
  }
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  )
    return false;
  if (
    Object.getPrototypeOf(actual) !== Object.prototype ||
    Object.getPrototypeOf(expected) !== Object.prototype
  )
    return false;
  const keys = Object.keys(actual);
  return (
    keys.length === Object.keys(expected).length &&
    keys.every((key) => Object.hasOwn(expected, key) && same(actual[key], expected[key]))
  );
}

export const runtimeAssertions = {
  equal(actual, expected) {
    if (!Object.is(actual, expected))
      throw new Error(`runtime value mismatch: ${String(actual)} !== ${String(expected)}`);
  },
  notEqual(actual, expected) {
    if (Object.is(actual, expected))
      throw new Error(`runtime values unexpectedly equal: ${String(actual)}`);
  },
  deepEqual(actual, expected) {
    if (!same(actual, expected)) throw new Error("runtime bytes or record mismatch");
  },
  async rejects(promise, predicate) {
    try {
      await promise;
    } catch (error) {
      if (predicate(error)) return;
      throw new Error("runtime rejection did not match expected error", { cause: error });
    }
    throw new Error("runtime operation unexpectedly succeeded");
  },
};
