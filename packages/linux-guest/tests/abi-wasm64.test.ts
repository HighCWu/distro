// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { abi_checks as checks32, NR as nr32, stat_size as size32 } from "../src/abi.ts";
import { abi_checks, NR, Stat, stat_size } from "../src/abi-wasm64.ts";

test("native wasm64 syscall aliases do not expose ILP32 calling conventions", () => {
  assert.equal(NR.lseek, 62);
  assert.equal(NR.newfstatat, 79);
  assert.equal(NR.fstat, 80);
  assert.equal(NR.ftruncate, 46);
  for (const name of ["llseek", "fstatat64", "fstat64", "ftruncate64"]) {
    assert.ok(!Object.hasOwn(NR, name));
  }
  assert.equal(nr32.llseek, 62);
  assert.equal(nr32.fstat64, 80);
  assert.equal(NR.read, nr32.read);
  assert.equal(size32, 104);
});

test("native stat preserves large inode, signed size and 64-bit timestamp fields", () => {
  assert.equal(stat_size, 128);
  assert.equal(Stat.size, stat_size);
  const storage = new Uint8Array(144).fill(0xa5);
  const view = storage.subarray(8, 136);
  const raw = new DataView(view.buffer, view.byteOffset, view.byteLength);
  raw.setBigUint64(8, 9007199254740993n, true);
  raw.setBigInt64(48, -9007199254740993n, true);
  raw.setBigInt64(72, -3000000000n, true);
  raw.setBigUint64(80, 999999999n, true);
  raw.setBigInt64(88, 3000000000n, true);
  raw.setBigUint64(96, 123456789n, true);
  raw.setBigInt64(104, 9007199254740993n, true);
  raw.setBigUint64(112, 987654321n, true);
  const stat = new Stat(view);
  assert.equal(stat.st_ino, 9007199254740993n);
  assert.equal(stat.st_size, -9007199254740993n);
  assert.equal(stat.st_atime, -3000000000n);
  assert.equal(stat.st_atime_nsec, 999999999n);
  assert.equal(stat.st_mtime, 3000000000n);
  assert.equal(stat.st_mtime_nsec, 123456789n);
  assert.equal(stat.st_ctime, 9007199254740993n);
  assert.equal(stat.st_ctime_nsec, 987654321n);
  stat.st_mtime = -1n;
  assert.equal(raw.getBigInt64(88, true), -1n);
  assert.ok(storage.subarray(0, 8).every((byte) => byte === 0xa5));
  assert.ok(storage.subarray(136).every((byte) => byte === 0xa5));
});

test("native ABI retains shared checked facts without mutating the wasm32 schema", () => {
  for (const check of checks32.scalars.filter((entry) => !entry.c.startsWith("__NR_"))) {
    assert.ok(abi_checks.scalars.includes(check));
  }
  assert.equal(abi_checks.structs.find((entry) => entry.c === "struct stat")?.sizeof, 128);
  assert.ok(!abi_checks.structs.some((entry) => entry.c === "struct stat64"));
  assert.equal(checks32.structs.find((entry) => entry.c === "struct stat64")?.sizeof, 104);
  assert.ok(abi_checks.exprs.some((entry) => entry.expr === "sizeof(void *) == 8"));
  assert.ok(abi_checks.exprs.some((entry) => entry.expr === "sizeof(long) == 8"));
});

test("C assertion generator accepts the native schema and emits LP64 target checks", () => {
  const run = spawnSync(
    process.execPath,
    [
      process.env.AGENT_ABI_TEST_GENERATOR ??
        fileURLToPath(new URL("../../../distro/guest-agent/gen-abi-check.ts", import.meta.url)),
      process.env.AGENT_ABI_TEST_SCHEMA ??
        fileURLToPath(new URL("../src/abi-wasm64.ts", import.meta.url)),
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /sizeof\(void \*\) == 8/);
  assert.match(run.stdout, /sizeof\(struct stat\) == 128/);
  assert.match(run.stdout, /offsetof\(struct stat, st_mtime\) == 88/);
  assert.match(run.stdout, /__NR_newfstatat/);
  assert.doesNotMatch(
    run.stdout,
    /__NR_llseek|__NR_fstatat64|__NR_fstat64|__NR_ftruncate64|struct stat64/,
  );
});
