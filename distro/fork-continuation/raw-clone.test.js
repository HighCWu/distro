// SPDX-License-Identifier: MIT
// Native fixture checking only: this shim does not validate Wasm continuations.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = fileURLToPath(new URL("./raw-clone.c", import.meta.url));
const shim = `
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>
int raw_clone_continuation_probe(void);
int raw_clone_refusal_probe(void);
int raw_clone3_continuation_probe(void);
static int mode;
static int clone3_child;
long raw_legacy_syscall(long nr, long a, long b, long c, long d, long e, long f)
{
  (void)nr; (void)a; (void)b; (void)c; (void)d; (void)e; (void)f;
  return -ENOSYS;
}
long raw_linux_syscall(long nr, long a, long b, long c, long d, long e, long f)
{
  // This is a native fork shim for fixture validation, not native clone3 or
  // Wasm evidence. The actual Wasm parser has separate dual-width tests.
  if (nr == SYS_clone3) {
    if (mode == 1) return -EOPNOTSUPP;
    if ((unsigned long)b > 65536) return -E2BIG;
    if (b < 64) return -EINVAL;
    if (!a || a == -8) return -EFAULT;
    const uint64_t *args = (const uint64_t *)a;
    if (b > 88 && args[11]) return -E2BIG;
    if (args[0] || args[4] != SIGCHLD) return -EOPNOTSUPP;
    long result = fork();
    if (!result) clone3_child = 1;
    return result < 0 ? -errno : result;
  }
  if (nr == SYS_clone) {
    if (mode == 1 || a != SIGCHLD || b || c || d || e) return -EOPNOTSUPP;
    long result = fork();
    return result < 0 ? -errno : result;
  }
  long result = syscall(nr, a, b, c, d, e, f);
  if (nr == SYS_getppid && (mode == 2 || (mode == 3 && clone3_child))) result++;
  return result < 0 ? -errno : result;
}
int main(int argc, char **argv)
{
  mode = argc > 1 ? atoi(argv[1]) : 0;
  if (mode == 1) return !raw_clone_refusal_probe();
  if (mode == 3) return raw_clone3_continuation_probe();
  if (mode == 0 && !raw_clone3_continuation_probe()) return 1;
  return raw_clone_continuation_probe() != (mode == 0);
}
`;

for (const compiler of ["gcc", "clang"]) {
  test(`${compiler}: raw clone workload, refusal and wrong-child negative control`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "raw-clone-fixture-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const glue = join(dir, "shim.c"),
      binary = join(dir, "probe");
    writeFileSync(glue, shim);
    const built = spawnSync(
      compiler,
      ["-O2", "-Wall", "-Wextra", "-Werror", source, glue, "-o", binary],
      {
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.equal(built.status, 0, built.stderr);
    for (const mode of [0, 1, 2, 3]) {
      const result = spawnSync(binary, [String(mode)], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, `mode ${mode}: ${result.stderr}`);
    }
  });
}
