// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertProcessOutput } from "../../packages/browser-tests/process-contract.js";

for (const cc of ["gcc", "clang"])
  test(`${cc}: pidfd lifecycle, stop/continue and false-status rejection`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pidfd-contract-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    // Host clone3 may be blocked by the enclosing container. This explicit
    // fork+pidfd_open shim checks the C workload, NOT atomic kernel creation.
    const source = readFileSync(new URL("process-control.c", import.meta.url), "utf8");
    const original = source.replace(
      "return syscall(SYS_clone3, (long)request, (long)sizeof *request, 0L, 0L, 0L, 0L);",
      `if (!request->pidfd || request->pidfd == UINT64_MAX - 7) { errno = EFAULT; return -1; }
  /* Reserve before fork so the EMFILE fixture cannot create a child. */
  int reservation = open("/", O_RDONLY | O_CLOEXEC);
  if (reservation < 0) return -1;
  long child = fork();
  int saved = errno;
  close(reservation);
  if (child > 0) {
    int fd = open_pid((pid_t)child, 0);
    if (fd < 0) { kill((pid_t)child, SIGKILL); waitpid((pid_t)child, 0, 0); return -1; }
    *(int *)(uintptr_t)request->pidfd = fd;
  }
  if (child < 0) errno = saved;
  return child;`,
    );
    assert.notEqual(original, source);
    const wrong = original.replace(
      "return syscall(SYS_pidfd_send_signal, (long)fd, (long)signal, 0L, (long)flags, 0L, 0L);",
      "(void)fd; (void)signal; (void)flags; return 0;",
    );
    assert.notEqual(wrong, original);
    const wrongStatus = original.replace(
      "int main(void)",
      `static int wrong_waitid(idtype_t type, id_t id, siginfo_t *info, int options)
{
  int result = waitid(type, id, info, options);
  if (!result && info && info->si_code == CLD_CONTINUED) info->si_status = SIGTERM;
  return result;
}
#define waitid wrong_waitid
int main(void)`,
    );
    assert.notEqual(wrongStatus, original);
    const wrongPidfd = original.replace(
      "*(int *)(uintptr_t)request->pidfd = fd;",
      "fcntl(fd, F_SETFD, 0); *(int *)(uintptr_t)request->pidfd = fd;",
    );
    assert.notEqual(wrongPidfd, original);
    for (const [name, source] of [
      ["normal", original],
      ["wrong-signal", wrong],
      ["wrong-continued-status", wrongStatus],
      ["wrong-pidfd-cloexec", wrongPidfd],
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
      if (name === "normal") {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assertProcessOutput(run.stdout, "pidfd");
      } else {
        assert.notEqual(run.status, 0);
        assert.match(
          run.stdout,
          name === "wrong-signal"
            ? /invalid descriptor/
            : name === "wrong-pidfd-cloexec"
              ? /clone3 pidfd close-on-exec/
              : /continued identity and signal status/,
        );
        assert.doesNotMatch(run.stdout, /::vm-test::pass/);
      }
    }
  });
