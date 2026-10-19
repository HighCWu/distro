// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

// A bounded test-only repeat profile; not a runtime or SDK setting.
export function forkIterations(stability) {
  assert.ok(stability === undefined || stability === "1", "unknown fork stability profile");
  return stability === "1" ? 4 : 2;
}

export const forkStages = [
  "fork: raw syscall continuation, identity, isolation and wait pass",
  "fork-exec: untransformed raw clone refusal pass",
  "fork: pending signal isolation and inherited handler pass",
  "fork: continuation, PID, TLS, atfork, mask, memory, fd and nested wait pass",
  "fork: rejected exec preserves image and later fork pass",
  "fork-exec: inherited mask and reset handler pass",
  "fork-exec: arguments, environment, TLS and identity pass",
  "fork: exec replacement and wait pass",
  "fork: multithread refusal and recovery pass",
  "fork: flags-first clone ABI and legacy callback coexistence pass",
  "fork: signal callback refusal and later fork recovery pass",
  "::vm-test::pass",
];

export const forkFaultStages = [
  "fork-fault: initialization and allocation errors, atfork, mask and no-child pass",
  "fork-fault: publication timeout, late child rejection and parent recovery pass",
  "fork-fault: eight recovery forks, identity, TLS, isolation and single reap pass",
  "::vm-test::pass",
];

export function assertForkOutput(output, mode = "normal") {
  assert.ok(mode === "normal" || mode === "faults", "unknown fork test mode");
  assert.equal(typeof output, "string", "missing runtime console output");
  assert.ok(!output.includes("::vm-test::fail"), "user program reported failure");
  const lines = new Set(output.split(/\r?\n/));
  for (const stage of mode === "faults" ? forkFaultStages : forkStages)
    assert.ok(lines.has(stage), `missing stage: ${stage}`);
}
