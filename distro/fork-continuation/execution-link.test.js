// SPDX-License-Identifier: MIT
// Freestanding link/import regression only: not a libc or Linux runtime test.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const compiler = process.env.FORK_LINK_CLANG || "clang";
for (const width of [32, 64]) {
  test(`wasm${width}: callback and flags-first imports link separately, collision fails`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-link-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "sys"));
    writeFileSync(join(dir, "stdint.h"), "typedef __UINTPTR_TYPE__ uintptr_t;\n");
    writeFileSync(join(dir, "signal.h"), "#define SIGCHLD 17\n");
    writeFileSync(
      join(dir, "sys/syscall.h"),
      `
#define SYS_clone 220
#define SYS_getpid 172
#define SYS_getppid 173
#define SYS_exit_group 94
#define SYS_wait4 260
`,
    );
    const run = (args) =>
      spawnSync(
        compiler,
        [
          `--target=wasm${width}-unknown-unknown`,
          "-nostdinc",
          "-nostdlib",
          "-I",
          dir,
          "-O2",
          "-Wall",
          "-Wextra",
          "-Werror",
          ...args,
        ],
        { encoding: "utf8", timeout: 30000 },
      );
    const execution = fileURLToPath(new URL("./execution.c", import.meta.url));
    const raw = fileURLToPath(new URL("./raw-clone.c", import.meta.url));
    const callbackObject = join(dir, "callback.o"),
      rawObject = join(dir, "raw.o");
    for (const [source, output] of [
      [execution, callbackObject],
      [raw, rawObject],
    ]) {
      const result = run(["-c", source, "-o", output]);
      assert.equal(result.status, 0, result.stderr || String(result.error));
    }
    const output = join(dir, "linked.wasm");
    const flags = [
      "-Wl,--no-entry",
      "-Wl,--export=raw_clone_continuation_probe",
      "-Wl,--export=raw_clone_refusal_probe",
    ];
    const linked = run([callbackObject, rawObject, ...flags, "-o", output]);
    assert.equal(linked.status, 0, linked.stderr || String(linked.error));
    const module = new WebAssembly.Module(readFileSync(output));
    assert.deepEqual(
      WebAssembly.Module.imports(module)
        .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
        .sort(),
      ["linux.syscall:function", "linux.syscall_v2:function"],
    );
    const collision = join(dir, "collision.c");
    writeFileSync(
      collision,
      readFileSync(execution, "utf8").replaceAll("fork_callback_syscall", "raw_linux_syscall"),
    );
    const rejected = run([collision, rawObject, ...flags, "-o", join(dir, "collision.wasm")]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /import name mismatch/);
  });
}
