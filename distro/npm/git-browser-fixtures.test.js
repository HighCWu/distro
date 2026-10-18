// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkReport } from "./browser-report-check.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../../packages/browser-tests/git-app.js");
const spec = read("../../packages/browser-tests/git-tests/git.spec.js");
const recipe = read("./browser-tests.nix");
const titles = [
  "runs installed Git commits, conflict merges, hooks and pager through Linux",
  "runs installed Git threaded repack, fsck and gc through Linux",
  "runs installed Git credential cache and loopback HTTP clone through Linux",
];
const variants = ["workflow", "packing", "remote"];
const stages = [
  "Git workflow: commit, conflict merge, object, hook and pager verified",
  "Git packing: object roundtrip, threaded repack, strict fsck, gc and packed history verified",
  "Git remote: credential cache and loopback HTTP discovery/clone verified",
];
const notices = "Git notices: selected installed originals and default patch checksums verified";

function appContext(overrides = {}) {
  const context = { Uint8Array, ...overrides };
  runInNewContext(app.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  return context;
}

test("Git disposable root storage retains binary writes without modifying a fresh root", () => {
  const context = appContext();
  const storage = context.gitRootStorage(Uint8Array.of(0, 1, 2, 3));
  assert.equal(storage.capacity, 4);
  assert.equal(storage.write(1, Uint8Array.of(0x80, 0xff)), 2);
  const result = new Uint8Array(4);
  assert.equal(storage.read(0, result), 4);
  assert.deepEqual(result, Uint8Array.of(0, 0x80, 0xff, 3));
  storage.flush();
  context.gitRootStorage(Uint8Array.of(0, 1, 2, 3)).read(0, result);
  assert.deepEqual(result, Uint8Array.of(0, 1, 2, 3));
});

for (const variant of variants) {
  test(`Git ${variant} boots only after both installed assets load and rejects unavailable images`, async () => {
    const requests = [];
    const boots = [];
    const context = appContext({
      fetch: async (path) => {
        requests.push(path);
        return { ok: true, arrayBuffer: async () => new ArrayBuffer(512) };
      },
      consoleDevice() {},
      entropyDevice() {},
      blockDevice: (storage) => storage,
      bootMachine: async (options) => boots.push(options),
      runRuntimeSmoke: async (options) => {
        await options.loadInitramfs();
        await options.bootMachine({ plugins: ["console", "entropy"] });
      },
    });
    await context.runGitRuntime(variant);
    assert.deepEqual(requests.sort(), [`/runtime-${variant}.cpio`, `/root-${variant}.ext4`].sort());
    assert.deepEqual(Array.from(boots[0].plugins.slice(0, 2)), ["console", "entropy"]);
    assert.equal(boots[0].plugins[2].capacity, 512);
    assert.equal(typeof boots[0].plugins[2].write, "function");
    for (const missing of requests) {
      context.fetch = async (path) => ({
        ok: path !== missing,
        status: 503,
        arrayBuffer: async () => new ArrayBuffer(512),
      });
      await assert.rejects(context.runGitRuntime(variant), /Git image load failed:.*503/);
      assert.equal(boots.length, 1);
    }
    assert.throws(() => context.runGitRuntime("../other"), /invalid Git variant/);
  });
}

function casesFor(output, addressBits, profileOk = true) {
  const cases = new Map();
  const register = (title, body) => cases.set(title, body);
  register.setTimeout = () => {};
  const expect = (value) => ({
    toBe: (wanted) => assert.equal(value, wanted),
    toContain: (wanted) => assert.ok(value.includes(wanted), String(wanted)),
    not: { toContain: (wanted) => assert.ok(!value.includes(wanted), String(wanted)) },
  });
  expect.poll = (body) => ({ toBe: async (wanted) => assert.equal(await body(), wanted) });
  runInNewContext(spec.replace(/^import .*;\n/gm, ""), {
    test: register,
    expect,
    console,
    runGitRuntime: async () => output,
  });
  return {
    cases,
    page: {
      on() {},
      goto: async () => {},
      evaluate: async (body, value) => body(value),
      request: { get: async () => ({ ok: () => profileOk, json: async () => ({ addressBits }) }) },
    },
  };
}

test("actual Git browser cases require matching runtime width, notices, scenario stage and final pass", async () => {
  for (const bits of [32, 64])
    for (const [index, title] of titles.entries()) {
      const lines = [
        `Git ABI: long and size_t match ${bits} bits`,
        notices,
        stages[index],
        "::vm-test::pass",
      ];
      for (const missing of [-1, ...lines.keys()]) {
        const { cases, page } = casesFor(lines.filter((_, i) => i !== missing).join("\n"), bits);
        assert.deepEqual([...cases.keys()], titles);
        if (missing === -1) await cases.get(title)({ page });
        else await assert.rejects(cases.get(title)({ page }));
      }
      for (const [text, width, ok] of [
        [lines.join("\n") + "\n::vm-test::fail", bits, true],
        [lines.join("\n"), bits === 32 ? 64 : 32, true],
        [lines.join("\n"), 128, true],
        [lines.join("\n"), bits, false],
      ]) {
        const { cases, page } = casesFor(text, width, ok);
        await assert.rejects(cases.get(title)({ page }));
      }
    }
});

test("Git browser suites reuse Node installed assets and strictly require all three cases without skips or retries", () => {
  assert.match(recipe, /runtime = if bits == 64 then git-wasm64 else git;/);
  assert.ok(
    recipe.includes(
      'variants = [\n        "workflow"\n        "packing"\n        "remote"\n      ];',
    ),
  );
  assert.ok(recipe.includes("cp ${assets.${variant}.initramfs} $out/runtime-${variant}.cpio"));
  assert.ok(
    recipe.includes("cp ${builtins.head assets.${variant}.disks} $out/root-${variant}.ext4"),
  );
  for (const bits of [32, 64])
    for (const browser of ["chromium", "firefox"])
      assert.ok(recipe.includes(`"git-wasm${bits}-${browser}"`));
  for (const [index, variant] of variants.entries())
    assert.ok(read(`../git/${variant}-test.sh`).includes(stages[index]));
  for (const title of titles) assert.ok(recipe.includes(`"${title}"`));
  const report = {
    suites: [
      {
        specs: titles.map((title) => ({
          title,
          tests: [{ status: "expected", results: [{ status: "passed", retry: 0 }] }],
        })),
      },
    ],
    stats: { expected: 3, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
  };
  checkReport(report, titles);
  for (const mutate of [
    (r) => r.suites[0].specs.pop(),
    (r) => r.suites[0].specs.push({ ...r.suites[0].specs[0], title: "extra" }),
    (r) => {
      r.stats.skipped = 1;
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].retry = 1;
    },
  ]) {
    const bad = structuredClone(report);
    mutate(bad);
    assert.throws(() => checkReport(bad, titles));
  }
});
