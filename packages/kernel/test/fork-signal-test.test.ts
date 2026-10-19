// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import {
  fork_signal_test,
  fork_resume_signal_test,
  inject_saved_fork_signal,
  inject_resume_fork_signal,
} from "../src/fork-signal-test.ts";

test("saved-fork signal seam is inactive in a default build", () => {
  if (fork_signal_test) return;
  for (const address of ["i32", "i64"] as const)
    assert.doesNotThrow(() =>
      inject_saved_fork_signal(() => {
        assert.fail("default build issued an injected syscall");
      }, address),
    );
});

test("post-clone signal seam is inactive in a default build", () => {
  if (fork_resume_signal_test) return;
  for (const address of ["i32", "i64"] as const)
    assert.doesNotThrow(() =>
      inject_resume_fork_signal(() => {
        assert.fail("default build issued a post-clone injected syscall");
      }, address),
    );
});
