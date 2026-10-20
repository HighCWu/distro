// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { summarizeBoots } from "./benchmark-contract.js";

export function pairSchedule(manifest) {
  return Array.from({ length: 3 }, (_, repeat) => {
    const cases = repeat % 2 ? [...manifest.cases].reverse() : manifest.cases;
    return cases.flatMap((c, index) =>
      ((repeat + index) % 2 ? ["bundled", "baseline"] : ["baseline", "bundled"]).map((variant) => ({
        variant,
        repeat,
        caseId: c.id,
      })),
    );
  }).flat();
}

export function summarizePair(boots, manifest) {
  assert.notEqual(manifest.profile, true, "pair must be uninstrumented");
  assert.deepEqual(
    boots.map(({ variant, repeat, caseId }) => ({ variant, repeat, caseId })),
    pairSchedule(manifest),
    "all adjacent alternating pairs required",
  );
  const summary = Object.fromEntries(
    ["baseline", "bundled"].map((variant) => [
      variant,
      summarizeBoots(
        boots.filter((b) => b.variant === variant),
        manifest,
      ),
    ]),
  );
  const ratios = summary.baseline.map((base, i) => ({
    caseId: base.caseId,
    bundledOverBaseline: Object.fromEntries(
      Object.keys(base.timings).map((phase) => [
        phase,
        summary.bundled[i].timings[phase].medianOfBootMediansNs /
          base.timings[phase].medianOfBootMediansNs,
      ]),
    ),
  }));
  return { summary, ratios };
}
