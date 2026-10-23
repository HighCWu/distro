// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { processStages, assertProcessOutput } from "./process-contract.js";

for (const corpus of Object.keys(processStages))
  test(`${corpus}: exact ordered stage admission`, () => {
    const lines = [...processStages[corpus], "::vm-test::pass"];
    const output = lines.join("\n");
    assert.doesNotThrow(() => assertProcessOutput(output, corpus));
    for (const bad of [
      lines.slice(1).join("\n"),
      [...lines].reverse().join("\n"),
      output + "\n::vm-test::pass",
      output + "\n::vm-test::fail",
      output + "\nrcu: detected stall",
    ])
      assert.throws(() => assertProcessOutput(bad, corpus));
    assert.throws(() => assertProcessOutput(output, "toString"));
    const foreign = Object.values(processStages)
      .flat()
      .find((stage) => !lines.includes(stage));
    assert.ok(foreign);
    assert.throws(() => assertProcessOutput(output + "\n" + foreign, corpus));
  });

for (const corpus of ["dash", "bash", "useraccess", "upper32", "altstack", "stacklegacy"])
  test(`${corpus}: browser controller requires two boots, closed browser and no late page error`, (t) => {
    const dir = mkdtempSync(join(tmpdir(), "process-browser-host-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const file of ["process-browser-check.mjs", "process-contract.js"])
      copyFileSync(new URL(file, import.meta.url), join(dir, file));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    const profile = {
      addressBits: corpus === "upper32" ? 32 : 64,
      corpus,
      cpus: ["upper32", "useraccess", "altstack", "stacklegacy"].includes(corpus) ? 1 : 2,
    };
    writeFileSync(join(dir, "profile.json"), JSON.stringify(profile));
    writeFileSync(
      join(dir, "server.js"),
      'console.log("Listening on http://127.0.0.1:12345"); setInterval(()=>{},1000);',
    );
    const module = join(dir, "node_modules/playwright");
    mkdirSync(module, { recursive: true });
    writeFileSync(
      join(module, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    const output = [...processStages[corpus], "::vm-test::pass"].join("\n");
    writeFileSync(
      join(module, "index.js"),
      `
    import {EventEmitter} from 'node:events';
    const page = new EventEmitter();
    page.goto = async()=>{}; page.waitForFunction = async()=>{};
    page.evaluate = async fn => String(fn).includes('crossOriginIsolated') ? true : ${JSON.stringify(output)};
    let connected = true;
    const browser = {version:()=> 'mock', newPage:async()=>page, isConnected:()=>connected,
      close:async()=>{ connected=false; if(process.env.PROCESS_BROWSER_LATE) page.emit('pageerror',Error('late failure')); }};
    export const chromium={launch:async()=>browser}; export const firefox=chromium;
  `,
    );
    for (const late of [false, true]) {
      const run = spawnSync(process.execPath, ["process-browser-check.mjs", "chromium"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20000,
        env: { ...process.env, PROCESS_BROWSER_LATE: late ? "1" : "" },
      });
      assert.equal(run.error, undefined);
      if (late) {
        assert.notEqual(run.status, 0);
        assert.match(run.stderr, /late browser errors/);
        assert.doesNotMatch(run.stdout, /both iterations and browser shutdown pass/);
      } else {
        assert.equal(run.status, 0, run.stdout + run.stderr);
        assert.equal((run.stdout.match(/and machine shutdown pass/g) ?? []).length, 2);
        assert.match(run.stdout, /both iterations and browser shutdown pass/);
      }
    }
    for (const wrong of [
      { ...profile, cpus: profile.cpus === 1 ? 2 : 1 },
      ...(corpus === "upper32" ? [{ ...profile, addressBits: 64 }] : []),
    ]) {
      writeFileSync(join(dir, "profile.json"), JSON.stringify(wrong));
      const run = spawnSync(process.execPath, ["process-browser-check.mjs", "chromium"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(run.error, undefined);
      assert.notEqual(run.status, 0);
      assert.match(run.stderr, /CPU profile mismatch|upper-half profile requires wasm32/);
      assert.doesNotMatch(run.stdout, /both iterations and browser shutdown pass/);
    }
    const app = readFileSync(new URL("process-app.js", import.meta.url), "utf8");
    assert.match(app, /runRuntimeSmoke/);
    assert.match(app, /crossOriginIsolated/);
  });

test("signal stack browser suites reuse both-width standard and missing-export workloads", () => {
  const recipe = readFileSync(
    new URL("../../distro/npm/browser-tests.nix", import.meta.url),
    "utf8",
  );
  for (const corpus of ["altstack", "stacklegacy"])
    for (const bits of [32, 64])
      for (const engine of ["chromium", "firefox"])
        assert.ok(recipe.includes(`"process-${corpus}-wasm${bits}-${engine}"`));
  assert.match(
    recipe,
    /if corpus == "altstack" then\s+\(if bits == 64 then toolchain-smoke-wasm64 else toolchain-smoke\)\s*\.checks\.signal-altstack\.runtimeAssets/,
  );
  assert.match(
    recipe,
    /else if corpus == "stacklegacy" then\s+\(if bits == 64 then toolchain-smoke-wasm64 else toolchain-smoke\)\s*\.checks\.signal-stack-legacy\.runtimeAssets/,
  );
});

test("Bash browser suite uses the ordinary-fork candidate and exact shell stages", () => {
  const recipe = readFileSync(
    new URL("../../distro/npm/browser-tests.nix", import.meta.url),
    "utf8",
  );
  assert.match(recipe, /"process-bash-wasm64-chromium"/);
  assert.match(recipe, /"process-bash-wasm64-firefox"/);
  assert.match(
    recipe,
    /if corpus == "bash" then\s+assert bits == 64;\s+bash-fork-wasm64\.checks\.runtime\.runtimeAssets/,
  );
  const script = readFileSync(
    new URL("../../distro/bash-fork/processes.sh", import.meta.url),
    "utf8",
  );
  for (const stage of processStages.bash) assert.ok(script.includes(stage + "\\n"));
});

test("user-access browser recipes select exact variants, CPU counts and user stages", () => {
  const recipe = readFileSync(
    new URL("../../distro/npm/browser-tests.nix", import.meta.url),
    "utf8",
  );
  for (const project of [
    "process-upper32-wasm32-chromium",
    "process-upper32-wasm32-firefox",
    "process-useraccess-wasm64-chromium",
    "process-useraccess-wasm64-firefox",
  ])
    assert.ok(recipe.includes('"' + project + '"'));
  assert.match(
    recipe,
    /assert bits == 32;\s+toolchain-smoke\.checks\.user-access-upper32\.runtimeAssets/,
  );
  assert.match(recipe, /inherit \(assets\) cpus/);
  const source = readFileSync(
    new URL("../../distro/toolchain-smoke/user-access.c", import.meta.url),
    "utf8",
  );
  for (const stage of processStages.upper32) assert.ok(source.includes(stage));
});

test("browser app admits CPU profiles before loading initramfs and preserves legacy default", async (t) => {
  const keys = ["fetch", "crossOriginIsolated", "bootProcessRuntimeSmoke", "processCpuProfileTest"];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const dataUrl = (source) =>
    "data:text/javascript;base64," + Buffer.from(source).toString("base64");
  const kernel = dataUrl(
    "export const bootMachine=()=>{}, consoleDevice=()=>{}, entropyDevice=()=>{};",
  );
  const runtime = dataUrl(`export async function runRuntimeSmoke(options) {
    globalThis.processCpuProfileTest.push(options.cpus);
    await options.loadInitramfs(); return 'host profile pass';
  }`);
  const app = readFileSync(new URL("process-app.js", import.meta.url), "utf8")
    .replace('"@lowland/kernel"', JSON.stringify(kernel))
    .replace('"./runtime-smoke.js"', JSON.stringify(runtime));
  await import(dataUrl(app));
  globalThis.crossOriginIsolated = true;
  globalThis.processCpuProfileTest = [];
  let profile = {},
    ok = true,
    initLoads = 0;
  globalThis.fetch = async (path) => {
    if (path === "/profile.json") return { ok, status: ok ? 200 : 404, json: async () => profile };
    assert.equal(path, "/runtime.cpio");
    initLoads++;
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  for (const value of [1, 2, undefined]) {
    profile = value === undefined ? {} : { cpus: value };
    assert.equal(await globalThis.bootProcessRuntimeSmoke(), "host profile pass");
  }
  assert.deepEqual(globalThis.processCpuProfileTest, [1, 2, 2]);
  for (const value of [0, 3, 1.5, null, "1"]) {
    profile = { cpus: value };
    await assert.rejects(globalThis.bootProcessRuntimeSmoke(), /invalid process CPU profile/);
  }
  ok = false;
  await assert.rejects(globalThis.bootProcessRuntimeSmoke(), /process profile load failed: 404/);
  globalThis.crossOriginIsolated = false;
  await assert.rejects(globalThis.bootProcessRuntimeSmoke(), /requires cross-origin isolation/);
  assert.equal(initLoads, 3, "bad profiles never load initramfs or start a machine");
  assert.deepEqual(globalThis.processCpuProfileTest, [1, 2, 2]);
});
