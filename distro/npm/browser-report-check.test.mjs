// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { checkReport } from "./browser-report-check.mjs";

function fixture() {
  return {
    suites: [
      {
        suites: [
          {
            specs: [
              {
                title: "runtime",
                tests: [{ status: "expected", results: [{ status: "passed", retry: 0 }] }],
              },
            ],
          },
        ],
      },
    ],
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
  };
}
test("accepts the required executed case", () => checkReport(fixture(), ["runtime"]));
for (const mutation of ["missing", "extra", "skip", "retry", "expected failure", "error"]) {
  test(`rejects ${mutation} despite successful aggregate statistics`, () => {
    const report = fixture();
    const specs = report.suites[0].suites[0].specs;
    if (mutation === "missing") specs.length = 0;
    if (mutation === "extra") specs.push(structuredClone(specs[0]));
    if (mutation === "skip") specs[0].tests[0].results[0].status = "skipped";
    if (mutation === "retry") specs[0].tests[0].results[0].retry = 1;
    if (mutation === "expected failure") specs[0].tests[0].results[0].status = "failed";
    if (mutation === "error") report.errors.push({ message: "worker crashed" });
    assert.throws(() => checkReport(report, ["runtime"]));
  });
}
