// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latencyServer } from "./latency-server.js";
import { browserBoot } from "./latency-browser-boot.mjs";
import {
  latencyCases,
  latencyManifest,
  latencySchedule,
  latencySummary,
} from "./latency-contract.js";
const variants = ["native", "node", "chromium", "firefox"];
const manifest = () => ({
  schemaVersion: 1,
  addressBits: 64,
  samples: 30,
  warmups: 1,
  cpus: 2,
  cases: latencyCases,
});
test("four-platform rotation requires all 72 slots, browser version, isolation and both close gates", () => {
  const m = latencyManifest(manifest()),
    schedule = latencySchedule(m, variants);
  assert.equal(schedule.length, 72);
  for (let i = 0; i < 72; i += 4) {
    assert.equal(new Set(schedule.slice(i, i + 4).map((b) => b.caseId)).size, 1);
    assert.deepEqual(new Set(schedule.slice(i, i + 4).map((b) => b.variant)), new Set(variants));
  }
  const boots = schedule.map((b) => ({
    ...b,
    closed: true,
    ...(["chromium", "firefox"].includes(b.variant)
      ? {
          browserClosed: true,
          browserVersion: "fixture-version",
          pageEnvironment: { crossOriginIsolated: true },
        }
      : {}),
    output:
      Array.from(
        { length: 30 },
        (_, sample) =>
          "fork-latency: " +
          JSON.stringify({
            sample,
            exec: m.cases.find((c) => c.id === b.caseId).exec,
            payload_bytes: m.cases.find((c) => c.id === b.caseId).payloadBytes,
            linear_bytes: b.variant === "native" ? 0 : 80 * 1048576,
            parent_ns: 100 + sample,
            wait_ns: 200 + sample,
          }),
      ).join("\n") + "\n::vm-test::pass\n",
  }));
  const summary = latencySummary(boots, m, variants);
  assert.equal(summary.length, 6);
  for (const s of summary)
    for (const v of variants) assert.equal(s.variants[v].wait_ns.pooled.samples, 90);
  const index = boots.findIndex((b) => b.variant === "firefox");
  for (const change of [
    { closed: false },
    { browserClosed: false },
    { browserVersion: "" },
    { pageEnvironment: { crossOriginIsolated: false } },
  ])
    assert.throws(() =>
      latencySummary(
        boots.map((b, i) => (i === index ? { ...b, ...change } : b)),
        m,
        variants,
      ),
    );
  assert.throws(() => latencySummary(boots.slice(1), m, variants));
  assert.throws(() => latencySchedule(m, ["chromium", "firefox"]));
});
test("loopback server supplies real module MIME/isolation and rejects non-assets and traversal", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "latency-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "kernel/dist"), { recursive: true });
  writeFileSync(join(dir, "kernel/dist/index.js"), "export const marker=1;");
  writeFileSync(join(dir, "kernel/vmlinux.wasm"), "wasm fixture");
  writeFileSync(join(dir, "exit-1.cpio"), "cpio fixture");
  const server = latencyServer(dir);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = await fetch(origin);
  assert.equal(html.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
  assert.equal(html.headers.get("Cross-Origin-Embedder-Policy"), "require-corp");
  assert.match(await html.text(), /importmap/);
  for (const [path, type] of [
    ["/kernel/dist/index.js", "text/javascript"],
    ["/kernel/vmlinux.wasm", "application/wasm"],
    ["/exit-1.cpio", "application/octet-stream"],
  ]) {
    const r = await fetch(origin + path);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("Cache-Control"), /immutable/);
    assert.ok(r.headers.get("Content-Type").startsWith(type));
    assert.ok(await r.text());
  }
  for (const path of [
    "/native/exit-1",
    "/latency-browser-run.mjs",
    "/kernel/dist/%2e%2e%2f%2e%2e%2fsecret.js",
  ]) {
    const r = await fetch(origin + path);
    assert.equal(r.status, 403);
  }
});
test("browser measurement stays fresh, pinned, bounded, uninstrumented and outside Nix result cache", () => {
  const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8");
  const recipe = read("latency-browser.nix");
  assert.match(recipe, /playwright.assertCompatible/);
  assert.match(recipe, /withChromium = true/);
  assert.match(recipe, /withFirefox = true/);
  assert.match(recipe, /1200s node/);
  assert.doesNotMatch(recipe, /mkCheck|--bundle|forkProfileTest/);
  const runner = read("latency-browser-run.mjs");
  const boot = read("latency-browser-boot.mjs");
  assert.match(boot, /launch\(\{\s*headless:\s*true/);
  assert.match(boot, /browser.close\(\)/);
  assert.match(boot, /!browser.isConnected\(\)/);
  assert.match(runner, /150000/);
  assert.match(runner, /latencySchedule\(m,\s*variants\)/);
  assert.doesNotMatch(runner, /@playwright\/test|tracing.start/);
  const app = read("latency-browser-app.js");
  assert.match(app, /await runRuntimeSmoke/);
  assert.match(app, /crossOriginIsolated/);
  const ci = read("../../.github/workflows/ci.yml");
  assert.match(ci, /fork-benchmark-browser-compare:/);
  assert.match(ci, /test "\$NATIVE_COMPARE" != true/);
});

test("browser lifecycle helper writes success only after both closures and refuses late page errors", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "latency-browser-life-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const scenario of [
    "pass",
    "isolation",
    "machineOpen",
    "lateError",
    "closeFail",
    "browserOpen",
  ]) {
    let connected = true,
      closed = 0;
    const listeners = new Map();
    const browser = {
      version: () => "fixture-browser-only",
      isConnected: () => connected,
      newPage: async () => ({
        on: (name, fn) => listeners.set(name, fn),
        goto: async () => {},
        waitForFunction: async () => {},
        evaluate: async (fn, arg) =>
          arg === undefined
            ? { crossOriginIsolated: scenario !== "isolation" }
            : { output: "fixture only", closed: scenario !== "machineOpen" },
      }),
      close: async () => {
        closed++;
        connected = scenario === "browserOpen";
        if (scenario === "lateError") listeners.get("pageerror")(Error("late renderer error"));
        if (scenario === "closeFail") throw Error("fixture close failure");
      },
    };
    const prefix = join(dir, scenario);
    const run = () =>
      browserBoot({
        engine: "chromium",
        caseId: "exit-1",
        prefix,
        origin: "http://fixture-only",
        engines: { chromium: { launch: async () => browser } },
      });
    if (scenario === "pass") {
      const b = await run();
      assert.equal(b.closed, true);
      assert.equal(b.browserClosed, true);
      assert.equal(b.browserVersion, "fixture-browser-only");
      assert.deepEqual(JSON.parse(readFileSync(prefix + ".stdout")), b);
      assert.equal(readFileSync(prefix + ".stderr", "utf8"), "");
    } else {
      await assert.rejects(run);
      assert.throws(() => readFileSync(prefix + ".stdout"));
    }
    assert.equal(closed, 1, scenario);
  }
});

test("four-platform driver mock exercises all slots, raw records, ratios and close-failure refusal", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "latency-browser-driver-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = manifest();
  for (const file of [
    "latency-browser-run.mjs",
    "latency-browser-boot.mjs",
    "latency-server.js",
    "latency-contract.js",
    "latency.c",
    "latency-exec.c",
  ])
    copyFileSync(new URL(file, import.meta.url), join(dir, file));
  for (const v of ["native", "wasm", "kernel", "node_modules/playwright"])
    mkdirSync(join(dir, v), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  writeFileSync(join(dir, "kernel/vmlinux.wasm"), "fixture only");
  writeFileSync(join(dir, "playwright-version.txt"), "fixture only");
  for (const v of ["native", "wasm"]) writeFileSync(join(dir, v, "compiler.txt"), "fixture only");
  const output = (c, v) =>
    Array.from(
      { length: 30 },
      (_, sample) =>
        "fork-latency: " +
        JSON.stringify({
          sample,
          exec: c.exec,
          payload_bytes: c.payloadBytes,
          linear_bytes: v === "native" ? 0 : 80 * 1048576,
          parent_ns: 100 + sample,
          wait_ns: 200 + sample,
        }),
    ).join("\n") + "\n::vm-test::pass\n";
  const browserResults = Object.fromEntries(
    m.cases.map((c) => [c.id, { output: output(c, "chromium"), closed: true }]),
  );
  for (const c of m.cases) {
    writeFileSync(
      join(dir, "native", c.id),
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output(c, "native"))});`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "wasm", c.id + ".wasm"), "fixture only");
  }
  writeFileSync(
    join(dir, "latency-boot.mjs"),
    `console.log(JSON.stringify(${JSON.stringify(browserResults)}[process.argv[3]]));`,
  );
  writeFileSync(
    join(dir, "node_modules/playwright/package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  writeFileSync(
    join(dir, "node_modules/playwright/index.js"),
    `
    const results=${JSON.stringify(browserResults)};
    const engine={launch:async()=>{let connected=true;return {version:()=>"fixture-not-a-real-browser",isConnected:()=>connected,newPage:async()=>({on:()=>{},goto:async()=>{},waitForFunction:async()=>{},evaluate:async(fn,arg)=>arg===undefined?{crossOriginIsolated:true}:results[arg]}),close:async()=>{if(process.env.LATENCY_FIXTURE_FAIL)throw Error("fixture close failure");connected=false;}};}};
    export const chromium=engine; export const firefox=engine;
  `,
  );
  const run = (folder, fail = false) =>
    spawnSync(process.execPath, [join(dir, "latency-browser-run.mjs"), dir, join(dir, folder)], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, LATENCY_FIXTURE_FAIL: fail ? "1" : "" },
    });
  const p = run("results");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /all 72 measurement slots/);
  const r = JSON.parse(readFileSync(join(dir, "results/report.json")));
  assert.equal(r.boots.length, 72);
  assert.equal(r.experiment, "native-node-browser-fork-latency-v1");
  for (const b of r.boots) {
    const name = `${b.variant}-${b.repeat}-${b.caseId}`;
    assert.ok(readFileSync(join(dir, "results", name + ".stdout"), "utf8"));
    assert.equal(readFileSync(join(dir, "results", name + ".stderr"), "utf8"), "");
  }
  for (const s of r.ratios)
    for (const v of ["node", "chromium", "firefox"]) assert.equal(s.overNativeP50[v].wait_ns, 1);
  assert.notEqual(run("results").status, 0);
  const bad = run("failed", true);
  assert.notEqual(bad.status, 0);
  assert.throws(() => readFileSync(join(dir, "failed/report.json")));
});
