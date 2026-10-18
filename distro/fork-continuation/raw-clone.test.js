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
#include <sys/syscall.h>
#include <unistd.h>
int raw_clone_continuation_probe(void);
int raw_clone_refusal_probe(void);
static int mode;
long raw_linux_syscall(long nr, long a, long b, long c, long d, long e, long f)
{
  if (nr == SYS_clone) {
    if (a || b) return -EINVAL;
    if (mode == 1 || c != SIGCHLD || d || e || f) return -EOPNOTSUPP;
    long result = fork();
    return result < 0 ? -errno : result;
  }
  long result = syscall(nr, a, b, c, d, e, f);
  if (nr == SYS_getppid && mode == 2) result++;
  return result < 0 ? -errno : result;
}
int main(int argc, char **argv)
{
  mode = argc > 1 ? atoi(argv[1]) : 0;
  if (mode == 1) return !raw_clone_refusal_probe();
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
    for (const mode of [0, 1, 2]) {
      const result = spawnSync(binary, [String(mode)], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, `mode ${mode}: ${result.stderr}`);
    }
  });
}
