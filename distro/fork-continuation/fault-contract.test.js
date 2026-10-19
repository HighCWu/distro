// SPDX-License-Identifier: MIT
// Host evidence only; the faults checks boot the actual Wasm kernel/libc.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Worker } from "node:worker_threads";

test("default fault seam is disabled; a build-only substitution enables a finite per-machine plan", async (t) => {
  const source = readFileSync(
    new URL("../../packages/kernel/src/copy-fault.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export const copy_fault_test = false;/);
  const dir = mkdtempSync(join(tmpdir(), "copy-fault-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "enabled.mts");
  writeFileSync(
    path,
    source.replace("export const copy_fault_test = false;", "export const copy_fault_test = true;"),
  );
  const enabled = await import(pathToFileURL(path).href);
  const first = enabled.create_copy_fault_plan(),
    second = enabled.create_copy_fault_plan();
  for (const expected of ["initialize", "allocate", "timeout", null, null]) {
    assert.equal(first(), expected);
    assert.equal(second(), expected);
  }
  assert.throws(
    () => enabled.inject_copy_fault("initialize", "initialize"),
    /injected copy initialize/,
  );
  assert.throws(() => enabled.inject_copy_fault("allocate", "allocate"), /injected copy allocate/);
  assert.doesNotThrow(() => enabled.inject_copy_fault("initialize", "allocate"));
  assert.equal(enabled.copy_status_words(), 3);
  const status = new Int32Array(new SharedArrayBuffer(12));
  enabled.mark_copy_timeout(status, "timeout");
  const copyModule = new URL("../../packages/kernel/src/user-copy.ts", import.meta.url).href;
  const worker = new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    parentPort.once('message', async (status) => {
      const enabled = await import(${JSON.stringify(pathToFileURL(path).href)});
      const { settle_user_copy, USER_COPY_COMPLETE } = await import(${JSON.stringify(copyModule)});
      parentPort.postMessage('ready');
      enabled.pause_copy_publication('timeout', status);
      const published = settle_user_copy(status, USER_COPY_COMPLETE);
      if (!published) enabled.acknowledge_copy_timeout('timeout', status);
      parentPort.postMessage({ published, entered: published, result: Atomics.load(status, 0) });
      parentPort.close();
    });
  `,
    { eval: true },
  );
  t.after(() => worker.terminate());
  const exited = new Promise((resolve) => worker.once("exit", resolve));
  const message = () =>
    new Promise((resolve, reject) => {
      const fail = (error) => {
        worker.off("message", receive);
        reject(error);
      };
      const receive = (value) => {
        worker.off("error", fail);
        resolve(value);
      };
      worker.once("message", receive);
      worker.once("error", fail);
    });
  const ready = message();
  worker.postMessage(status);
  assert.equal(await ready, "ready");
  Atomics.wait(status, 1, 0, 2000);
  assert.equal(Atomics.load(status, 1), 1, "child reached publication gate");
  const outcome = message();
  const { wait_user_copy } = await import(copyModule);
  assert.equal(wait_user_copy(status, 0), -11);
  enabled.join_copy_timeout(status);
  assert.deepEqual(await outcome, { published: false, entered: false, result: -11 });
  assert.equal(Atomics.load(status, 1), 2);
  assert.equal(await exited, 0);
  const noCheckpoint = new Int32Array(new SharedArrayBuffer(12));
  Atomics.store(noCheckpoint, 0, -11);
  assert.throws(
    () => enabled.acknowledge_copy_timeout("timeout", noCheckpoint),
    /missing publication/,
  );
  const escaped = new Int32Array(new SharedArrayBuffer(12));
  enabled.mark_copy_timeout(escaped, "timeout");
  Atomics.store(escaped, 0, 1);
  Atomics.store(escaped, 1, 2);
  assert.throws(() => enabled.pause_copy_publication("timeout", escaped), /expected parent EAGAIN/);
  Atomics.store(escaped, 1, 2);
  assert.throws(() => enabled.join_copy_timeout(escaped), /result changed/);
  const recipe = readFileSync(new URL("../npm/kernel.nix", import.meta.url), "utf8");
  assert.match(recipe, /copyFaultTest \? false/);
  assert.match(recipe, /postPatch =\s+lib.optionalString copyFaultTest/);
  const workload = readFileSync(new URL("./package.nix", import.meta.url), "utf8");
  assert.match(workload, /checks.faults/);
  assert.match(workload, /kernel = kernel.override \{ copyFaultTest = true; \}/);
  assert.match(workload, /init = "\$\{program\}\/fork-fault.wasm"/);
});

for (const compiler of ["gcc", "clang"]) {
  test(`${compiler}: native recovery workload passes without claiming injected Wasm failures`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "fork-fault-native-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const source = fileURLToPath(new URL("./fault-runtime.c", import.meta.url));
    const binary = join(dir, "probe");
    const built = spawnSync(
      compiler,
      ["-O2", "-pthread", "-Wall", "-Wextra", "-Werror", source, "-o", binary],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(built.status, 0, built.stderr);
    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /eight recovery forks, identity, TLS, isolation and single reap pass/);
    assert.match(run.stdout, /::vm-test::pass/);
    assert.doesNotMatch(run.stdout, /initialization and allocation errors/);
  });
}
