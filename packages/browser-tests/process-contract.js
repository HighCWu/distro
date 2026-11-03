// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";

const nullStage =
  "user-access: NULL data, pathname, structure and atomic targets reject without side effects pass";
const prefixStage =
  "user-access: partial boundary copies preserve file positions, suffixes and pipe accounting pass";
const recoveryStage = "user-access: zero lengths, valid retries and descriptor recovery pass";
export const processStages = {
  poll: [
    "cooperative poll: pure computation receives standard timer signal pass",
    "cooperative poll: siglongjmp restores execution and later timer delivery pass",
    "cooperative poll: targeted pthread signal and independent native TLS pass",
    "cooperative poll: strict seccomp pure-loop timer, raw exit and single reaping pass",
    "cooperative poll: nested handler computation receives unblocked signal and later timer recovers pass",
  ],
  dylink: [
    "dynamic loader: main symbols, canonical pointers and dlerror pass",
    "dynamic loader: Linux files, RUNPATH dependencies, GOT and constructors pass",
    "dynamic loader: aliases, local/global scope, dependency reuse and close pass",
    "dynamic loader: cyclic dependencies, peer constructors and canonical relocations pass",
    "dynamic loader: cross-module SIMD signatures and typed forward calls pass",
    "dynamic loader: first-thread private TLS initialization, isolation and resident reuse pass",
    "dynamic loader: constructor dlopen, nested rejection recovery and single initialization pass",
    "dynamic loader: real link maps, dependency scopes and metadata error recovery pass",
    "dynamic loader: byte-preserving filenames, BOM search and Unicode metadata pass",
    "dynamic loader: missing/malformed rejection, descriptor recovery and cleanup pass",
  ],
  resolver: [
    "curl resolver: pending DNS does not block an independent multi transfer pass",
    "curl resolver: delayed reply, new DNS request and exact HTTP bodies pass",
    "curl resolver: resolver/server thread joins, descriptor recovery and cleanup pass",
  ],
  mmapstream: [
    "file mmap stream: multi-megabyte reads, nonzero offset, private copies and fd position pass",
    "file mmap stream: short reads, EOF zero tails, truncation and source lifetime pass",
    "file mmap stream: rejection rollback, split unmap and later allocation recovery pass",
  ],
  remotevm: [
    "process-vm: permission refusal, independent child reads, vector ordering and page crossings pass",
    "process-vm: partial transfers, kernel errors and actual remote writes pass",
    "process-vm: child observation, reap, self access and later fork recovery pass",
    "process-vm: pure user busy-loop reads, writes, memory growth and child observation pass",
  ],
  altstack: [
    "signal-altstack: standard registration, query and kernel error paths pass",
    "signal-altstack: siginfo context, nested on-stack delivery and normal return pass",
    "signal-altstack: autodisarm visibility, nested delivery and registration restoration pass",
    "signal-altstack: repeated SjLj escape, mask and original-frame recovery pass",
    "signal-altstack: context stack/mask edits, SIGKILL protection, disable and cleanup pass",
  ],
  stacklegacy: [
    "signal-stack-legacy: missing stack export refused and ordinary callbacks preserved pass",
  ],
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
    "exec-fd: malformed image abort preserves process and later descriptor exec pass",
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
