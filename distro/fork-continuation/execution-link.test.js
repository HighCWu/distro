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
    writeFileSync(
      join(dir, "stdint.h"),
      "typedef __UINTPTR_TYPE__ uintptr_t; typedef __UINT64_TYPE__ uint64_t;\n",
    );
    writeFileSync(join(dir, "stddef.h"), "#define offsetof(t, m) __builtin_offsetof(t, m)\n");
    writeFileSync(join(dir, "signal.h"), "#define SIGCHLD 17\n");
    writeFileSync(
      join(dir, "sys/syscall.h"),
      `
#define SYS_clone 220
#define SYS_clone3 435
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
      rawObject = join(dir, "raw.o"),
      memoryObject = join(dir, "memory.o");
    const memory = join(dir, "memory.c");
    // The freestanding fixture has no libc; keep struct zeroing linkable without
    // replacing the production probe's ordinary C initialization.
    writeFileSync(
      memory,
      "void *memset(void *p, int c, __SIZE_TYPE__ n) { volatile unsigned char *b = p; while (n--) *b++ = (unsigned char)c; return p; }\n",
    );
    for (const [source, output] of [
      [execution, callbackObject],
      [raw, rawObject],
      [memory, memoryObject],
    ]) {
      const result = run(["-c", source, "-o", output]);
      assert.equal(result.status, 0, result.stderr || String(result.error));
    }
    const output = join(dir, "linked.wasm");
    const flags = [
      "-Wl,--no-entry",
      "-Wl,--export=raw_clone_continuation_probe",
      "-Wl,--export=raw_clone_refusal_probe",
      "-Wl,--export=raw_clone3_continuation_probe",
    ];
    const linked = run([callbackObject, rawObject, memoryObject, ...flags, "-o", output]);
    assert.equal(linked.status, 0, linked.stderr || String(linked.error));
    const module = new WebAssembly.Module(readFileSync(output));
    assert.deepEqual(
      WebAssembly.Module.imports(module)
        .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
        .sort(),
      ["linux.syscall:function", "linux.syscall_v2:function"],
    );
    const calls = [];
    const instance = new WebAssembly.Instance(module, {
      linux: {
        syscall: (...args) => {
          calls.push(args);
          return width === 64 ? -11n : -11;
        },
        syscall_v2: () => {
          throw Error("unexpected kernel call");
        },
      },
    });
    assert.equal(
      instance.exports.__wasm_fork_syscall_abi(),
      2,
      "new objects must not advertise ABI 1 to old loaders",
    );
    const pointer = width === 64 ? (1n << 40n) + 7n : 8193;
    assert.equal(instance.exports.__wasm_fork_clone_pidfd(pointer), width === 64 ? -11n : -11);
    const p = (n) => (width === 64 ? BigInt(n) : n);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], p(220));
    assert.ok(calls[0][1] > 0, "continuation child callback");
    assert.deepEqual(calls[0].slice(2), [p(0), p(0x1011), pointer, p(0), p(0)]);
    const collision = join(dir, "collision.c");
    writeFileSync(
      collision,
      readFileSync(execution, "utf8").replaceAll("fork_callback_syscall", "raw_linux_syscall"),
    );
    const rejected = run([
      collision,
      rawObject,
      memoryObject,
      ...flags,
      "-o",
      join(dir, "collision.wasm"),
    ]);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /import name mismatch/);
  });
}
