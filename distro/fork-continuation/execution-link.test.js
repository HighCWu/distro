// SPDX-License-Identifier: MIT
// Freestanding link/import regression only: not a libc or Linux runtime test.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { user_function_imports_supported } from "../../packages/kernel/src/user-functions.ts";

const compiler = process.env.FORK_LINK_CLANG || "clang";
for (const width of [32, 64]) {
  test(`wasm${width}: callback and flags-first imports link separately, collision fails`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-link-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "sys"));
    writeFileSync(
      join(dir, "stdint.h"),
      "typedef __UINTPTR_TYPE__ uintptr_t; typedef __UINT64_TYPE__ uint64_t; typedef __INT32_TYPE__ int32_t;\n#define UINT32_C(x) x##U\n#define UINT64_C(x) x##ULL\n#define UINT64_MAX __UINT64_MAX__\n",
    );
    writeFileSync(join(dir, "errno.h"), "#define EOPNOTSUPP 95\n#define EINVAL 22\n");
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
    assert(user_function_imports_supported(readFileSync(output), width === 64 ? "i64" : "i32"));
    assert.equal(
      WebAssembly.Module.exports(module).some((x) => x.name === "__wasm_fork_user_poll_abi"),
      false,
    );
    const combined = join(dir, "combined.wasm");
    const pollLinked = run([
      "-DWASM_FORK_USER_POLL=1",
      execution,
      rawObject,
      memoryObject,
      ...flags,
      "-o",
      combined,
    ]);
    assert.equal(pollLinked.status, 0, pollLinked.stderr || String(pollLinked.error));
    const pollInstance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(combined)), {
      linux: {
        syscall: () => (width === 64 ? -11n : -11),
        syscall_v2: () => (width === 64 ? -95n : -95),
      },
    });
    assert.equal(pollInstance.exports.__wasm_fork_user_poll_abi(), 1);
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
    const parent = pointer + p(8),
      child = pointer + p(16);
    assert.equal(instance.exports.__wasm_fork_clone_options(p(0x01301000), pointer, child), p(-11));
    assert.equal(calls[1][0], p(220), "legacy TID transport retains the clone syscall");
    assert.deepEqual(calls[1].slice(2), [p(0), p(0x01301011), pointer, child, p(0)]);
    assert.equal(
      instance.exports.__wasm_fork_clone3_native(p(0x01300000), pointer, parent, child),
      p(-11),
    );
    assert.equal(calls[2][0], p(435), "native transport uses generic Linux clone3");
    assert.equal(calls[2][2], p(88));
    const view = new DataView(instance.exports.memory.buffer, Number(calls[2][1]), 88);
    assert.deepEqual(
      Array.from({ length: 11 }, (_, index) => view.getBigUint64(index * 8, true)),
      [0x01301000n, BigInt(pointer), BigInt(child), BigInt(parent), 17n, 0n, 0n, 0n, 0n, 0n, 0n],
      "compiled C preserves u64 fields and distinct PIDFD/parent/child outputs",
    );
    assert.equal(
      instance.exports.__wasm_fork_clone3_flags64(0x100000000n, pointer, parent, child),
      p(-11),
    );
    assert.equal(calls[3][0], p(435));
    const wide = new DataView(instance.exports.memory.buffer, Number(calls[3][1]), 88);
    assert.equal(
      wide.getBigUint64(0, true),
      0x100001000n,
      "real C i64 argument preserves high flags on wasm32 and wasm64",
    );
    assert.equal(wide.getBigUint64(24, true), BigInt(parent));
    if (width === 64)
      assert.equal(
        instance.exports.__wasm_fork_clone3_native(0x100000000n, pointer, parent, child),
        p(-95),
        "old helper keeps its low-flag scope",
      );
    assert.equal(
      instance.exports.__wasm_fork_clone3_flags64(1n << 63n, pointer, parent, child),
      p(-95),
    );
    assert.equal(calls.length, 4, "unknown high flags never reach Linux");
    assert.equal(instance.exports.__wasm_fork_clone3_features(), 15);
    assert.equal(
      instance.exports.__wasm_fork_clone3_flags64(0x100000080n, pointer, parent, child),
      p(-11),
    );
    assert.equal(calls.length, 5);
    assert.equal(calls[4][0], p(435));
    assert.equal(
      new DataView(instance.exports.memory.buffer, Number(calls[4][1]), 88).getBigUint64(0, true),
      0x100001080n,
      "NEWTIME remains a clone3 flag alongside CLEAR_SIGHAND and PIDFD",
    );
    assert.equal(
      instance.exports.__wasm_fork_clone3_native(p(0x80), pointer, parent, child),
      p(-95),
    );
    assert.equal(instance.exports.__wasm_fork_clone_options(p(0x80), pointer, child), p(-95));
    assert.equal(calls.length, 5, "old helpers still refuse the conflicting signal bit");
    assert.equal(
      instance.exports.__wasm_fork_clone3_flags64(0x200000000n, pointer, parent, child),
      p(-95),
    );
    assert.equal(calls.length, 5, "old wide signature cannot silently choose fd zero");
    assert.equal(
      instance.exports.__wasm_fork_clone3_cgroup(0x200000000n, pointer, parent, child, 19n),
      p(-11),
    );
    const grouped = new DataView(instance.exports.memory.buffer, Number(calls[5][1]), 88);
    assert.equal(grouped.getBigUint64(0, true), 0x200001000n);
    assert.equal(grouped.getBigUint64(80, true), 19n);
    assert.equal(instance.exports.__wasm_fork_clone3_flags64(0n, p(0), p(0), p(0)), p(-11));
    const plain = new DataView(instance.exports.memory.buffer, Number(calls[6][1]), 88);
    assert.equal(plain.getBigUint64(0, true), 0n);
    assert.equal(plain.getBigUint64(80, true), 0n, "ordinary clone3 clears stale cgroup");
    assert.equal(instance.exports.__wasm_fork_clone3_set_tid(0, 60001), 0);
    assert.equal(instance.exports.__wasm_fork_clone3_set_tid(1, -19), 0);
    assert.equal(instance.exports.__wasm_fork_clone3_set_tid(32, 1), -22);
    assert.equal(
      instance.exports.__wasm_fork_clone3_pid_select(0n, pointer, parent, child, 0n, 2),
      p(-11),
    );
    const selected = new DataView(instance.exports.memory.buffer, Number(calls[7][1]), 88);
    assert.equal(selected.getBigUint64(72, true), 2n);
    const ids = new DataView(
      instance.exports.memory.buffer,
      Number(selected.getBigUint64(64, true)),
      8,
    );
    assert.deepEqual([ids.getInt32(0, true), ids.getInt32(4, true)], [60001, -19]);
    assert.equal(instance.exports.__wasm_fork_clone3_flags64(0n, p(0), p(0), p(0)), p(-11));
    const recovered = new DataView(instance.exports.memory.buffer, Number(calls[8][1]), 88);
    assert.equal(recovered.getBigUint64(64, true), 0n);
    assert.equal(recovered.getBigUint64(72, true), 0n);
    assert.equal(instance.exports.__wasm_fork_clone_options(p(0x600), p(0), p(0)), p(-11));
    assert.equal(calls[9][0], p(220));
    assert.equal(calls[9][3], p(0x611));
    assert.equal(instance.exports.__wasm_fork_clone3_flags64(0x600n, p(0), p(0), p(0)), p(-11));
    const sharing = new DataView(instance.exports.memory.buffer, Number(calls[10][1]), 88);
    assert.equal(sharing.getBigUint64(0, true), 0x600n);
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
