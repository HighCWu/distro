// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

export const benchmarkCases = [
  ["default", "work", "default", 0],
  ["fork-libc-raw", "work", "fork-libc-raw", 0],
  ["fork-libc-asyncify", "work", "fork-libc-asyncify", 0],
  ["sdk-asyncify", "work", "sdk-asyncify", 0],
  ...[1, 16, 64].map((mib) => [`fork-${mib}`, "fork", "sdk-asyncify", mib * 1024 * 1024]),
];

export function validateManifest(m) {
  assert.equal(m.schemaVersion, 1);
  assert.ok(m.addressBits === 32 || m.addressBits === 64);
  assert.equal(m.samples, 5);
  assert.equal(m.warmups, 1);
  assert.equal(m.cpus, 2);
  assert.equal(m.workIterations, 262144);
  assert.equal(m.syscallIterations, 4096);
  assert.deepEqual(
    m.cases.map((c) => [c.id, c.kind, c.variant, c.payloadBytes]),
    benchmarkCases,
  );
  for (const c of m.cases) assert.equal(c.binary, `${c.id}.wasm`);
  return m;
}

export function workChecksum(iterations) {
  let x = 42;
  for (let i = 0; i < iterations; i++) x = ((x ^ (x << 13)) + i + 2654435761) >>> 0;
  return x;
}
const integer = (n, label, minimum = 0) => {
  assert.ok(Number.isSafeInteger(n) && n >= minimum, `invalid ${label}`);
};

export function parseBenchmarkOutput(output, m, c) {
  assert.equal(typeof output, "string");
  assert.ok(!output.includes("::vm-test::fail"), "runtime failure");
  assert.ok(!/rcu:.*detected.*stall/i.test(output), "RCU stall");
  const lines = output.split(/\r?\n/);
  assert.equal(
    lines.filter((line) => line === "::vm-test::pass").length,
    1,
    "missing/duplicate pass",
  );
  const rows = lines
    .filter((line) => line.startsWith("fork-bench: "))
    .map((line) => JSON.parse(line.slice("fork-bench: ".length)));
  assert.equal(rows.length, m.samples * (c.kind === "work" ? 2 : 1), "missing/extra samples");
  const seen = new Set();
  for (const row of rows) {
    assert.equal(row.kind, c.kind, "wrong workload");
    integer(row.sample, "sample");
    assert.ok(row.sample < m.samples, "sample out of range");
    integer(row.linear_bytes, "linear memory", 65536);
    assert.equal(row.linear_bytes % 65536, 0, "not Wasm pages");
    if (c.kind === "fork") assert.equal(row.phase, undefined, "unexpected fork phase");
    const key = `${c.kind === "work" ? row.phase : "fork"}:${row.sample}`;
    assert.ok(!seen.has(key), "duplicate sample");
    seen.add(key);
    if (c.kind === "work") {
      assert.ok(row.phase === "calls" || row.phase === "syscalls", "unknown phase");
      const iterations = row.phase === "calls" ? m.workIterations : m.syscallIterations;
      assert.equal(row.iterations, iterations, "wrong iteration count");
      assert.equal(
        row.checksum,
        row.phase === "calls" ? workChecksum(iterations) : iterations,
        "wrong checksum",
      );
      integer(row.ns, "work duration", 1);
    } else {
      assert.equal(row.payload_bytes, c.payloadBytes, "wrong payload size");
      assert.ok(row.linear_bytes >= c.payloadBytes, "linear memory smaller than payload");
      integer(row.parent_ns, "parent duration", 1);
      integer(row.wait_ns, "fork+wait duration", row.parent_ns);
    }
  }
  return rows;
}

export function validateBoot(result, m, c) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.caseId, c.id);
  assert.equal(result.addressBits, m.addressBits);
  assert.equal(result.closed, true, "machine did not close");
  integer(result.peakProcessRssKiB, "whole-process peak RSS", 1);
  integer(result.kernelLinearBytes, "kernel linear memory", 65536);
  assert.equal(result.kernelLinearBytes % 65536, 0);
  return parseBenchmarkOutput(result.output, m, c);
}

export function median(values) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

export function summarizeBoots(boots, m) {
  assert.equal(boots.length, m.cases.length * 3, "three fresh processes per case required");
  return m.cases.map((c) => {
    const group = boots.filter((boot) => boot.caseId === c.id);
    assert.deepEqual(group.map((boot) => boot.repeat).sort(), [0, 1, 2]);
    const rows = group.map((boot) => validateBoot(boot, m, c));
    const phases = c.kind === "work" ? ["calls", "syscalls"] : ["parent", "wait"];
    const timings = Object.fromEntries(
      phases.map((phase) => {
        const bootMedians = rows.map((samples) =>
          median(
            samples
              .filter((row) => c.kind === "fork" || row.phase === phase)
              .map((row) => (c.kind === "work" ? row.ns : row[`${phase}_ns`])),
          ),
        );
        return [phase, { bootMediansNs: bootMedians, medianOfBootMediansNs: median(bootMedians) }];
      }),
    );
    return {
      caseId: c.id,
      payloadBytes: c.payloadBytes,
      timings,
      peakProcessRssKiB: group.map((boot) => boot.peakProcessRssKiB),
      kernelLinearBytes: group.map((boot) => boot.kernelLinearBytes),
      userLinearBytes: rows.map((samples) => samples.map((row) => row.linear_bytes)),
    };
  });
}
