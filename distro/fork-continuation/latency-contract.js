// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
export const latencyCases = [0, 1].flatMap((exec) =>
  [1, 16, 64].map((mib) => ({
    id: `${exec ? "exec" : "exit"}-${mib}`,
    exec,
    payloadBytes: mib * 1048576,
  })),
);
export function latencyManifest(m) {
  assert.equal(m.schemaVersion, 1);
  assert.ok(m.addressBits === 32 || m.addressBits === 64);
  assert.equal(m.samples, 30);
  assert.equal(m.warmups, 1);
  assert.equal(m.cpus, 2);
  assert.deepEqual(m.cases, latencyCases);
  return m;
}
export function parseLatency(output, m, c, variant) {
  assert.ok(["native", "node", "chromium", "firefox"].includes(variant));
  assert.equal(typeof output, "string");
  assert.ok(!/::vm-test::fail|rcu:.*detected.*stall|fork-profile:/i.test(output));
  const lines = output.split(/\r?\n/);
  assert.equal(lines.filter((l) => l === "::vm-test::pass").length, 1);
  const rows = lines
    .filter((l) => l.startsWith("fork-latency: "))
    .map((l) => JSON.parse(l.slice(14)));
  assert.equal(rows.length, m.samples);
  for (const [i, r] of rows.entries()) {
    assert.equal(r.sample, i);
    assert.equal(r.exec, c.exec);
    assert.equal(r.payload_bytes, c.payloadBytes);
    assert.ok(Number.isSafeInteger(r.parent_ns) && r.parent_ns > 0);
    assert.ok(Number.isSafeInteger(r.wait_ns) && r.wait_ns >= r.parent_ns);
    assert.ok(Number.isSafeInteger(r.linear_bytes));
    if (variant === "native") assert.equal(r.linear_bytes, 0);
    else assert.ok(r.linear_bytes >= c.payloadBytes && r.linear_bytes % 65536 === 0);
  }
  return rows;
}
export function latencySchedule(m, variants = ["native", "node"]) {
  assert.ok(
    JSON.stringify(variants) === JSON.stringify(["native", "node"]) ||
      JSON.stringify(variants) === JSON.stringify(["native", "node", "chromium", "firefox"]),
    "unknown comparison profile",
  );
  return [0, 1, 2].flatMap((repeat) =>
    (repeat % 2 ? [...m.cases].reverse() : m.cases).flatMap((c, i) =>
      [
        ...variants.slice((repeat + i) % variants.length),
        ...variants.slice(0, (repeat + i) % variants.length),
      ].map((variant) => ({
        repeat,
        caseId: c.id,
        variant,
      })),
    ),
  );
}
export function quantile(values, p) {
  assert.ok(values.length && p > 0 && p <= 1);
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
}
export function latencySummary(boots, m, variants = ["native", "node"]) {
  assert.deepEqual(
    boots.map(({ repeat, caseId, variant }) => ({ repeat, caseId, variant })),
    latencySchedule(m, variants),
  );
  return m.cases.map((c) => ({
    caseId: c.id,
    variants: Object.fromEntries(
      variants.map((variant) => {
        const group = boots.filter((b) => b.caseId === c.id && b.variant === variant);
        const rows = group.map((b) => {
          assert.equal(b.closed, true);
          if (variant === "chromium" || variant === "firefox") {
            assert.equal(b.browserClosed, true);
            assert.equal(typeof b.browserVersion, "string");
            assert.ok(b.browserVersion.length > 0);
            assert.equal(b.pageEnvironment.crossOriginIsolated, true);
          }
          return parseLatency(b.output, m, c, variant);
        });
        return [
          variant,
          Object.fromEntries(
            ["parent_ns", "wait_ns"].map((phase) => {
              const values = rows.flat().map((r) => r[phase]);
              return [
                phase,
                {
                  perBoot: rows.map((rs) => ({
                    p50: quantile(
                      rs.map((r) => r[phase]),
                      0.5,
                    ),
                    p95: quantile(
                      rs.map((r) => r[phase]),
                      0.95,
                    ),
                    max: Math.max(...rs.map((r) => r[phase])),
                  })),
                  pooled: {
                    samples: values.length,
                    p50: quantile(values, 0.5),
                    p95: quantile(values, 0.95),
                    max: Math.max(...values),
                  },
                },
              ];
            }),
          ),
        ];
      }),
    ),
  }));
}
