// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkReport } from "./browser-report-check.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../../packages/browser-tests/agent-python-git-root-app.js");
const spec = read("../../packages/browser-tests/agent-tests/agent-python-git-root.spec.js");
const recipe = read("./browser-tests.nix");
const title = "runs Python Git SQLite collaboration across fresh browser wasm64 roots";
const passed = [
  "Python Git workspace write through public SDK",
  "Python Git workspace read through public SDK",
];
const paths = ["/agent-boot.img", "/agent-root.ext4", "/git-workspace-example.py"];

test("combined browser loads exact boot, root and original example before entering shared suite", async () => {
  const requests = [],
    calls = [],
    stages = [],
    lines = [];
  const assertions = {};
  const context = {
    Uint8Array,
    console: { log: (line) => lines.push(line) },
    runtimeAssertions: assertions,
  };
  Object.assign(context, {
    fetch: async (path) => {
      requests.push(path);
      return { ok: true, arrayBuffer: async () => Uint8Array.of(paths.indexOf(path)).buffer };
    },
    runPythonGitRootWasm64Suite: async (...args) => {
      calls.push(args);
      await args[4]("write", async () => stages.push("write"));
      args[5]("console line\n");
      return { passed, closed: true };
    },
  });
  runInNewContext(app.replace(/^import[\s\S]*?;\n/gm, ""), context);
  assert.deepEqual(await context.runNativePythonGitRoot(), { passed, closed: true });
  assert.deepEqual(requests.sort(), [...paths].sort());
  assert.deepEqual(calls[0].slice(0, 3), [Uint8Array.of(0), Uint8Array.of(1), Uint8Array.of(2)]);
  assert.equal(calls[0][3], assertions);
  assert.deepEqual(stages, ["write"]);
  assert.deepEqual(lines, ["Python Git root passed: write", "console line"]);
  for (const missing of paths) {
    context.fetch = async (path) => ({
      ok: path !== missing,
      status: 503,
      arrayBuffer: async () => new ArrayBuffer(1),
    });
    await assert.rejects(context.runNativePythonGitRoot(), /Python Git asset load failed:.*503/);
    assert.equal(calls.length, 1, "incomplete assets must not start any Linux instance");
  }
});

test("combined browser propagates shared runtime errors without fabricating success", async () => {
  const context = {
    Uint8Array,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) }),
    runtimeAssertions: {},
    runPythonGitRootWasm64Suite: async () => {
      throw new Error("corrupt SQLite payload");
    },
  };
  runInNewContext(app.replace(/^import[\s\S]*?;\n/gm, ""), context);
  await assert.rejects(context.runNativePythonGitRoot(), /corrupt SQLite payload/);
});

async function browserCase(result, isolated = true) {
  const cases = new Map();
  const expect = (value) => ({
    toBe: (wanted) => assert.equal(value, wanted),
    toEqual: (wanted) => assert.equal(JSON.stringify(value), JSON.stringify(wanted)),
  });
  expect.poll = (body) => ({ toBe: async (wanted) => assert.equal(await body(), wanted) });
  const context = {
    test: (name, body) => cases.set(name, body),
    expect,
    console,
    crossOriginIsolated: isolated,
    runNativePythonGitRoot: async () => result,
  };
  runInNewContext(spec.replace(/^import .*;\n/gm, ""), context);
  assert.deepEqual([...cases.keys()], [title]);
  const page = {
    on() {},
    goto: async () => {},
    evaluate: async (body) => runInNewContext(`(${body.toString()})()`, context),
  };
  await cases.get(title)({ page });
}

test("browser acceptance requires both phases, order, close and cross-origin isolation", async () => {
  await browserCase({ passed, closed: true });
  for (const result of [
    { passed: passed.slice(0, 1), closed: true },
    { passed: passed.slice(1), closed: true },
    { passed: [...passed].reverse(), closed: true },
    { passed, closed: false },
    { passed: [...passed, "extra"], closed: true },
  ])
    await assert.rejects(browserCase(result));
  await assert.rejects(browserCase({ passed, closed: true }, false));
});

test("Node and browser use the same full suite with exact assets and strict report gate", () => {
  const node = read("../../packages/linux-guest/tests/agent-wasm64-python-git-root-runtime.ts");
  const suite = read("../../packages/linux-guest/tests/agent-wasm64-python-git-root-suite.ts");
  assert.ok(node.includes('from "./agent-wasm64-python-git-root-suite.ts"'));
  assert.ok(node.includes("runPythonGitRootWasm64Suite("));
  assert.doesNotMatch(suite, /node:|process\./);
  assert.ok(suite.includes('crypto.subtle.digest("SHA-256", payload)'));
  assert.ok(suite.indexOf("passed.push(title)") > suite.indexOf("closed++"));
  for (const browser of ["chromium", "firefox"])
    assert.ok(recipe.includes(`"agent-python-git-root-wasm64-${browser}"`));
  for (const required of [
    "assets = guest-agent.checks.python-git-root-wasm64;",
    "packages/linux-guest/tests/agent-wasm64-python-git-root-suite.ts",
    "cp ${assets.runtimeBootDisk} $out/agent-boot.img",
    "cp ${assets.runtimeRootfs} $out/agent-root.ext4",
    "cp ${../python/git-workspace-example.py} $out/git-workspace-example.py",
    `"${title}"`,
  ])
    assert.ok(recipe.includes(required), required);
  const report = {
    suites: [
      {
        specs: [
          { title, tests: [{ status: "expected", results: [{ status: "passed", retry: 0 }] }] },
        ],
      },
    ],
    stats: { expected: 1, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
  };
  checkReport(report, [title]);
  for (const mutate of [
    (r) => {
      r.suites[0].specs = [];
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].retry = 1;
    },
    (r) => {
      r.stats.skipped = 1;
    },
  ]) {
    const bad = structuredClone(report);
    mutate(bad);
    assert.throws(() => checkReport(bad, [title]));
  }
});
