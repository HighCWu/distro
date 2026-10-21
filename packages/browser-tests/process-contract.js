// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

const nullStage =
  "user-access: NULL data, pathname, structure and atomic targets reject without side effects pass";
const prefixStage =
  "user-access: partial boundary copies preserve file positions, suffixes and pipe accounting pass";
const recoveryStage = "user-access: zero lengths, valid retries and descriptor recovery pass";
export const processStages = {
  useraccess: [nullStage, prefixStage, recoveryStage],
  upper32: [
    nullStage,
    prefixStage,
    "user-access: wasm32 upper-half pipe buffers, structure output and atomic operands pass",
    recoveryStage,
  ],
  bash: [
    "bash-fork: standard fork, local scopes, command substitution and pipelines pass",
    "bash-fork: process substitution and coprocess fd lifetimes pass",
    "bash-fork: background wait, signal trap and parent isolation pass",
    "bash-fork: exec errors, syntax recovery and later child execution pass",
  ],
  execfd: [
    "exec-fd: close_range bounds, holes, UNSHARE and parent isolation pass",
    "exec-fd: prlimit64 errors, libc limits and full-width rlim_t roundtrip pass",
    "exec-fd: fexecve, execveat empty path and directory-relative execution pass",
    "exec-fd: replacement identity, TLS, CLOEXEC and inherited file offset pass",
    "exec-fd: close_range CLOEXEC preserves fd until exec and closes on replacement pass",
    "exec-fd: child NOFILE enforcement, exec inheritance and parent limit isolation pass",
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
    "process-control: SIGSTOP, WSTOPPED WNOWAIT and single stop consumption pass",
    "process-control: SIGCONT, WCONTINUED WNOWAIT and single continuation consumption pass",
    "process-control: pidfd signal, poll, waitid WNOWAIT and single reap pass",
    "process-control: clone3 CLONE_PIDFD, allocation rollback, child isolation and atomic identity pass",
    "process-control: later fork and wait recovery pass",
  ],
};
export function assertProcessOutput(output, corpus) {
  assert.ok(Object.hasOwn(processStages, corpus), "unknown process corpus");
  assert.doesNotMatch(output, /::vm-test::fail|Kernel panic|rcu:.*(?:stall|detected)/i);
  const lines = output.split(/\r?\n/);
  const known = new Set(Object.values(processStages).flat());
  for (const line of lines)
    if (known.has(line))
      assert.ok(processStages[corpus].includes(line), "unexpected process corpus stage");
  let previous = -1;
  for (const stage of [...processStages[corpus], "::vm-test::pass"]) {
    assert.equal(lines.filter((line) => line === stage).length, 1, `missing/duplicate ${stage}`);
    const index = lines.indexOf(stage);
    assert.ok(index > previous, "out-of-order process stages");
    previous = index;
  }
}
