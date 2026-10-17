// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

for (const fail of [false, true]) {
  for (const earlyClose of [false, true]) {
    test(`real runner shutdown failure=${fail}, early-close negative control=${earlyClose}`, () => {
      const temp = mkdtempSync(join(tmpdir(), "linux-wasm-runner-close-"));
      try {
        const initramfs = join(temp, "initramfs");
        const disk = join(temp, "disk");
        writeFileSync(initramfs, new Uint8Array([1]));
        writeFileSync(disk, new Uint8Array(512).fill(0x37));
        let runner = fileURLToPath(new URL("./run-test.js", import.meta.url));
        if (earlyClose) {
          // Reproduce the previous release ordering in an isolated subprocess.
          // Its program-pass/exit-0 result must not fool the positive assertions.
          const source = readFileSync(runner, "utf8")
            .replace(
              '"./protocol.js"',
              JSON.stringify(new URL("./protocol.js", import.meta.url).href),
            )
            .replace(
              '"./shutdown.js"',
              JSON.stringify(new URL("./shutdown.js", import.meta.url).href),
            )
            .replace(
              "await closeTestResources(machine, disks);",
              "machine?.close(); for (const disk of disks) closeSync(disk);",
            );
          runner = join(temp, "early-close.mjs");
          writeFileSync(
            runner,
            source.replace("#!/usr/bin/env node", 'import { closeSync } from "node:fs";'),
          );
        }
        const result = spawnSync(
          process.execPath,
          [
            runner,
            "--readonly-disks",
            fileURLToPath(new URL("./shutdown-fixture.js", import.meta.url)),
            initramfs,
            disk,
          ],
          {
            encoding: "utf8",
            timeout: 10000,
            env: { ...process.env, RUNNER_FIXTURE_FAIL: fail ? "1" : "0" },
          },
        );
        assert.ifError(result.error);
        assert.equal(result.signal, null);
        if (earlyClose) {
          assert.equal(result.status, 0, "negative control reproduces the false success");
          assert.match(result.stdout, /::vm-test::pass/);
          assert.doesNotMatch(result.stdout, /fixture: late disk read completed/);
          return;
        }
        assert.equal(result.status, fail ? 1 : 0, result.stdout + result.stderr);
        assert.match(result.stdout, /::vm-test::pass/);
        assert.match(result.stdout, /fixture: late disk read completed/);
        if (fail)
          assert.match(
            result.stderr,
            /::vm-test::fail: runner cleanup failed: Error: fixture flush failed/,
          );
        else assert.doesNotMatch(result.stderr, /::vm-test::fail/);
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    });
  }
}

for (const scenario of ["boot", "setup"]) {
  test(`runner rejects ${scenario} failure and releases already-opened disks`, () => {
    const temp = mkdtempSync(join(tmpdir(), "linux-wasm-runner-setup-"));
    try {
      const initramfs = join(temp, "initramfs");
      const disk = join(temp, "disk");
      writeFileSync(initramfs, new Uint8Array([1]));
      writeFileSync(disk, new Uint8Array(512).fill(0x37));
      const args = [
        fileURLToPath(new URL("./run-test.js", import.meta.url)),
        "--readonly-disks",
        fileURLToPath(new URL("./shutdown-fixture.js", import.meta.url)),
        initramfs,
        disk,
      ];
      if (scenario === "setup") args.push(join(temp, "missing-disk"));
      const result = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          RUNNER_FIXTURE_FAIL: "0",
          RUNNER_FIXTURE_SETUP_CHECK: "1",
          RUNNER_FIXTURE_BOOT_FAIL: scenario === "boot" ? "1" : "0",
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /::vm-test::fail: runner startup failed:/);
      assert.match(result.stdout, /fixture: fd closed after failed setup/);
      assert.doesNotMatch(result.stdout, /fixture: fd leaked/);
      if (scenario === "boot") assert.match(result.stdout, /::vm-test::pass/);
      else assert.doesNotMatch(result.stdout, /::vm-test::pass/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  "same-chunk",
  "separate-chunk",
  "shutdown-fail",
  "shutdown-panic",
  "buffered-fail",
  "normal-abort",
  "error-abort",
  "boot-pass",
  "boot-panic",
]) {
  test(`real runner preserves provisional pass semantics: ${scenario}`, () => {
    const temp = mkdtempSync(join(tmpdir(), "linux-wasm-runner-result-"));
    try {
      const initramfs = join(temp, "initramfs");
      const disk = join(temp, "disk");
      writeFileSync(initramfs, new Uint8Array([1]));
      writeFileSync(disk, new Uint8Array(512).fill(0x37));
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL("./run-test.js", import.meta.url)),
          "--readonly-disks",
          fileURLToPath(new URL("./shutdown-fixture.js", import.meta.url)),
          initramfs,
          disk,
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, RUNNER_FIXTURE_FAIL: "0", RUNNER_FIXTURE_SCENARIO: scenario },
        },
      );
      assert.ifError(result.error);
      assert.equal(
        result.status,
        scenario === "normal-abort" ? 0 : 1,
        result.stdout + result.stderr,
      );
      assert.match(result.stdout, /fixture: late disk read completed/);
      if (scenario !== "normal-abort") assert.match(result.stderr, /vm test failed:/);
      if (scenario === "boot-pass") assert.match(result.stderr, /no user pass/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}
