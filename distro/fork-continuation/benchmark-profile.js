// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

export function profileKinds(manifest) {
  const kinds = [
    "worker-start-message",
    "parent-ready",
    "child-ready",
    "child-prepare-rewind",
    "child-rewind-checkpoint",
  ];
  return (manifest.profileVersion ?? 1) >= 2
    ? [
        ...kinds,
        "worker-construct",
        "worker-online",
        "worker-main-turn",
        "worker-module-ready",
        "worker-init-posted",
      ]
    : kinds;
}

/** Diagnostic records are separate from baseline timing samples, including warmup forks. */
export function parseProfileOutput(output, manifest, c) {
  const records = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("fork-profile: "))
    .map((line) => JSON.parse(line.slice(14)));
  if (!manifest.profile || c.kind !== "fork") {
    assert.equal(records.length, 0, "unexpected profiling in baseline/non-fork case");
    return [];
  }
  const kinds = profileKinds(manifest);
  const requests = new Map();
  for (const record of records) {
    assert.equal(record.schemaVersion, manifest.profileVersion ?? 1);
    assert.equal(typeof record.request, "string");
    assert.ok(record.request.length > 0 && record.request.length <= 100);
    assert.ok(kinds.includes(record.kind), "unknown diagnostic kind");
    const fields =
      record.kind === "parent-ready" && manifest.profileVersion === 3
        ? ["ns", "wait_ns", "cooperate_ns", "cooperate_count", "ready_after_cooperate_count"]
        : record.kind === "child-ready"
          ? ["ns", "allocate_ns", "copy_ns", "kernel_instance_ns", "user_instance_ns"]
          : record.kind === "worker-module-ready"
            ? ["ns", "module_ns"]
            : record.kind === "worker-init-posted"
              ? ["ns", "queued_ns", "post_ns"]
              : ["ns"];
    for (const field of fields)
      assert.ok(Number.isSafeInteger(record[field]) && record[field] >= 0, `invalid ${field}`);
    if (record.kind === "parent-ready" && manifest.profileVersion === 3) {
      assert.ok(record.cooperate_ns <= record.wait_ns && record.wait_ns <= record.ns);
      assert.ok(record.ready_after_cooperate_count <= record.cooperate_count);
      assert.ok(record.cooperate_count !== 0 || record.cooperate_ns === 0);
    }
    const group = requests.get(record.request) ?? {};
    assert.ok(!Object.hasOwn(group, record.kind), "duplicate diagnostic phase");
    group[record.kind] = record;
    requests.set(record.request, group);
  }
  assert.equal(requests.size, manifest.samples + manifest.warmups, "missing/extra fork requests");
  for (const group of requests.values())
    assert.deepEqual(Object.keys(group).sort(), [...kinds].sort(), "incomplete diagnostic request");
  return [...requests.entries()].map(([request, phases]) => ({ request, phases }));
}
