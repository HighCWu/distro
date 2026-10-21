// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

export const processStages = {
  execfd: [
    "exec-fd: close_range bounds, holes, UNSHARE and parent isolation pass",
    "exec-fd: fexecve, execveat empty path and directory-relative execution pass",
    "exec-fd: replacement identity, TLS, CLOEXEC and inherited file offset pass",
    "exec-fd: close_range CLOEXEC preserves fd until exec and closes on replacement pass",
    "exec-fd: standard exec errors preserve original image and later fork pass",
  ],
  dash: [
    "dash: subshell, external exec and command substitution pass",
    "dash: pipelines and inherited fd redirection pass",
    "dash: background wait and foreground exit status pass",
    "dash: command errors, syntax unwind and later exec recovery pass",
  ],
  pidfd: [
    "process-control: pidfd identity, readiness, CLOEXEC and rejection pass",
    "process-control: pidfd signal, poll, waitid WNOWAIT and single reap pass",
    "process-control: later fork and wait recovery pass",
  ],
};
export function assertProcessOutput(output, corpus) {
  assert.ok(Object.hasOwn(processStages, corpus), "unknown process corpus");
  assert.doesNotMatch(output, /::vm-test::fail|Kernel panic|rcu:.*(?:stall|detected)/i);
  const lines = output.split(/\r?\n/);
  let previous = -1;
  for (const stage of [...processStages[corpus], "::vm-test::pass"]) {
    assert.equal(lines.filter((line) => line === stage).length, 1, `missing/duplicate ${stage}`);
    const index = lines.indexOf(stage);
    assert.ok(index > previous, "out-of-order process stages");
    previous = index;
  }
}
