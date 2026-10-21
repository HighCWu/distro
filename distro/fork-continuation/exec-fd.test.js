// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertProcessOutput } from "../../packages/browser-tests/process-contract.js";

for (const cc of ["gcc", "clang"])
  test(`${cc}: descriptor exec, close_range and negative controls`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "exec-fd-contract-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const original = readFileSync(new URL("exec-fd.c", import.meta.url), "utf8");
    const leaked = original.replace("open(path, O_RDONLY | O_CLOEXEC)", "open(path, O_RDONLY)");
    const noop = original.replace(
      "return syscall(SYS_close_range, (long)first, (long)last, (long)flags, 0L, 0L, 0L);",
      "(void)first; (void)last; (void)flags; return 0;",
    );
    const lostCloexec = original.replace(
      "(long)last, (long)flags, 0L",
      "(long)last, (long)(flags & ~range_cloexec), 0L",
    );
    const exclusiveEnd = original.replace(
      "(long)last, (long)flags, 0L",
      "(long)(last == first ? last : last - 1), (long)flags, 0L",
    );
    const narrowLimit = original.replace(
      "static void limit_control(struct rlimit *files)",
      `static int narrow_prlimit(pid_t pid, int resource, const struct rlimit *next, struct rlimit *old)
{
  int result = prlimit(pid, resource, next, old);
  if (!result && old && resource == RLIMIT_CORE) old->rlim_cur = (unsigned int)old->rlim_cur;
  return result;
}
#define prlimit narrow_prlimit
static void limit_control(struct rlimit *files)`,
    );
    assert.notEqual(leaked, original);
    assert.notEqual(noop, original);
    assert.notEqual(lostCloexec, original);
    assert.notEqual(exclusiveEnd, original);
    assert.notEqual(narrowLimit, original);
    // Native fixture simulation of Linux's 32-bit rlim64_is_infinity policy,
    // not execution on a 32-bit kernel. Actual target checks remain separate.
    const saturated = original
      .replace(
        "static void limit_control(struct rlimit *files)",
        `static int saturated_setrlimit(int resource, const struct rlimit *limit)
{
  struct rlimit converted = *limit;
  if (resource == RLIMIT_CORE && converted.rlim_cur >= 0xffffffffULL)
    converted.rlim_cur = RLIM_INFINITY;
  return setrlimit(resource, &converted);
}
#define setrlimit saturated_setrlimit
static void limit_control(struct rlimit *files)`,
      )
      .replace("sizeof(unsigned long) == 4", "1");
    assert.notEqual(saturated, original);
    for (const [name, source] of [
      ["normal", original],
      ["linux32-saturation", saturated],
      ["leaked-executable", leaked],
      ["range-noop", noop],
      ["range-lost-cloexec", lostCloexec],
      ["range-exclusive-end", exclusiveEnd],
      ["narrow-resource-limit", narrowLimit],
    ]) {
      const input = join(dir, name + ".c"),
        binary = join(dir, name);
      writeFileSync(input, source);
      const build = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-Werror", input, "-o", binary], {
        encoding: "utf8",
      });
      assert.equal(build.status, 0, build.stderr);
      const run = spawnSync(binary, [], { encoding: "utf8", timeout: 15000 });
      assert.equal(run.error, undefined);
      if (name === "normal" || name === "linux32-saturation") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assertProcessOutput(run.stdout, "execfd");
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          name === "range-noop"
            ? /range reversed bounds/
            : name === "range-exclusive-end"
              ? /range inclusivity, holes, upper bound and child isolation/
              : name === "narrow-resource-limit"
                ? /full-width core limit roundtrip/
                : /replacement identity, TLS, inherited fd and CLOEXEC/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
