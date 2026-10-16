// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkReport(report, expected) {
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites) visit(suite);
  assert.ok(expected.length > 0);
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(specs.map((spec) => spec.title).sort(), [...expected].sort());
  for (const spec of specs) {
    assert.equal(spec.tests.length, 1);
    const test = spec.tests[0];
    assert.equal(test.status, "expected");
    assert.equal(test.results.length, 1);
    assert.equal(test.results[0].status, "passed");
    assert.equal(test.results[0].retry, 0);
  }
  assert.equal(report.stats.expected, expected.length);
  for (const key of ["skipped", "unexpected", "flaky"]) assert.equal(report.stats[key], 0);
  assert.deepEqual(report.errors, []);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkReport(
    JSON.parse(readFileSync(process.argv[2], "utf8")),
    JSON.parse(readFileSync(process.argv[3], "utf8")),
  );
  console.log("Verified exact browser cases without skips or retries");
}
