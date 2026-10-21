// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkReport } from "./browser-report-check.mjs";

const app = readFileSync(
  new URL("../../packages/browser-tests/python-app.js", import.meta.url),
  "utf8",
);
const spec = readFileSync(
  new URL("../../packages/browser-tests/python-tests/python.spec.js", import.meta.url),
  "utf8",
);
const recipe = readFileSync(new URL("./browser-tests.nix", import.meta.url), "utf8");
const titles = [
  "runs installed full Python and relocated applications through Linux",
  "runs installed Python private anonymous mmap boundaries through Linux",
];
const stages = [
  [
    "Python application: relocated compressed archive, metadata, resources and binary pipes verified",
    "Python application: published MIT zipapp, resources, metadata and binary pipes verified",
    "Python spawn: PATH error precedence and original str/bytes executable verified",
    "Python spawn: repeated failed launches preserve parent fds, CLOEXEC and child cleanup",
    "Python spawn: descriptor exhaustion preserves parent fds and child cleanup",
    "Python process: timeout recovery, binary pipes, terminate, kill and reaping verified",
    "Python process: large duplex binary pipes preserve backpressure, bytes and child cleanup",
    "Python PTY: character devices, CLOEXEC, canonical/raw binary I/O and window size verified",
    "Python PTY session: controlling terminal, foreground group, binary I/O and reaping verified",
    "Python PTY signals: resize and terminal-generated interrupt reach foreground child",
  ],
  [
    "Python mmap: private anonymous bytes, buffer lifetime and close verified",
    "Python mmap: resize growth, shrink, zero tail, exported buffers and error recovery verified",
    "Python mmap: private flush preserves data and rejects unaligned ranges without file writeback",
    "Python mmap: madvise discards anonymous pages, preserves neighbors and live views, and rejects invalid advice",
    "Python mmap: default shared and file mappings rejected by default kernel",
  ],
];

function loadApp(overrides = {}) {
  const context = { Uint8Array, ...overrides };
  runInNewContext(app.replace(/^import .*;\n/gm, "").replace(/^export /gm, ""), context);
  return context;
}

test("Python root disk writes are visible to reads and do not affect a fresh disk", () => {
  const context = loadApp();
  const root = Uint8Array.of(0, 1, 2, 3);
  const storage = context.pythonRootStorage(root);
  assert.equal(storage.capacity, 4);
  assert.equal(storage.write(1, Uint8Array.of(0x80, 0xff)), 2);
  const result = new Uint8Array(4);
  assert.equal(storage.read(0, result), 4);
  assert.deepEqual(result, Uint8Array.of(0, 0x80, 0xff, 3));
  storage.flush();
  const fresh = context.pythonRootStorage(Uint8Array.of(0, 1, 2, 3));
  fresh.read(0, result);
  assert.deepEqual(result, Uint8Array.of(0, 1, 2, 3));
});

for (const variant of ["interpreter", "mmap"]) {
  test(`Python ${variant} loads the installed writable root before boot`, async () => {
    const requests = [];
    const boots = [];
    const progress = [];
    const context = loadApp({
      console: { info: (line) => progress.push(line) },
      fetch: async (path) => {
        requests.push(path);
        return { ok: true, arrayBuffer: async () => new Uint8Array(512).buffer };
      },
      consoleDevice: () => {},
      entropyDevice: () => {},
      blockDevice: (storage) => storage,
      bootMachine: async (options) => boots.push(options),
      runRuntimeSmoke: async (options) => {
        options.onProgress("shutdown completed");
        await options.loadInitramfs();
        await options.bootMachine({ plugins: ["console", "entropy"] });
      },
    });
    await context.runPythonRuntime(variant);
    assert.deepEqual(progress, [`[Python ${variant}] shutdown completed`]);
    assert.deepEqual(requests.sort(), [`/root-${variant}.ext4`, `/runtime-${variant}.cpio`].sort());
    assert.deepEqual(Array.from(boots[0].plugins.slice(0, 2)), ["console", "entropy"]);
    assert.equal(boots[0].plugins[2].capacity, 512);
    assert.equal(typeof boots[0].plugins[2].write, "function");
    for (const missing of [`/runtime-${variant}.cpio`, `/root-${variant}.ext4`]) {
      context.fetch = async (path) => ({
        ok: path !== missing,
        status: 503,
        arrayBuffer: async () => new ArrayBuffer(512),
      });
      await assert.rejects(context.runPythonRuntime(variant), /Python image load failed:.*503/);
      assert.equal(boots.length, 1, "failed image fetch must not boot");
    }
    assert.throws(() => context.runPythonRuntime("../other"), /invalid Python variant/);
  });
}

function loadCases(output, addressBits) {
  const cases = new Map();
  const register = (name, body) => cases.set(name, body);
  register.setTimeout = () => {};
  const expect = (value) => ({
    toContain: (wanted) => assert.ok(value.includes(wanted), String(wanted)),
    not: { toContain: (unwanted) => assert.ok(!value.includes(unwanted), String(unwanted)) },
  });
  expect.poll = (body) => ({ toBe: async (wanted) => assert.equal(await body(), wanted) });
  runInNewContext(spec.replace(/^import .*;\n/gm, ""), {
    test: register,
    expect,
    console,
    runPythonRuntime: async () => output,
  });
  return {
    cases,
    page: {
      on() {},
      goto: async () => {},
      evaluate: async (body, value) => body(value),
      request: { get: async () => ({ json: async () => ({ addressBits }) }) },
    },
  };
}

test("Python browser acceptance requires target width, layout, every stage and final pass", async () => {
  for (const bits of [32, 64]) {
    for (const [index, title] of titles.entries()) {
      const lines = [
        `Python ABI: pointer, size_t, long and sysconfig match ${bits} bits`,
        "Python layout: installed paths and operational flags exclude build-store paths",
        ...stages[index],
        "::vm-test::pass",
      ];
      for (const missing of [-1, ...lines.keys()]) {
        const { cases, page } = loadCases(lines.filter((_, i) => i !== missing).join("\n"), bits);
        assert.deepEqual([...cases.keys()], titles);
        if (missing === -1) await cases.get(title)({ page });
        else await assert.rejects(cases.get(title)({ page }));
      }
      for (const [text, width] of [
        [lines.join("\n") + "\n::vm-test::fail", bits],
        [lines.join("\n"), bits === 32 ? 64 : 32],
      ]) {
        const { cases, page } = loadCases(text, width);
        await assert.rejects(cases.get(title)({ page }));
      }
    }
  }
});

test("Python browser checks reuse exact installed assets and have a separate two-test report gate", () => {
  const runner = readFileSync(new URL("../vm-test/package.nix", import.meta.url), "utf8");
  assert.match(
    runner,
    /passthru\.runtimeAssets = \{\s+inherit initramfs cpus;\s+disks = allDisks;/,
  );
  assert.ok(recipe.includes("runtime.checks.${name}.runtimeAssets"));
  assert.match(recipe, /python-wasm64 else python/);
  for (const bits of [32, 64])
    for (const browser of ["chromium", "firefox"])
      assert.ok(recipe.includes(`"python-wasm${bits}-${browser}"`));
  for (const title of titles) assert.ok(recipe.includes(`"${title}"`));
  for (const variant of ["interpreter", "mmap"]) {
    assert.ok(recipe.includes(`cp \${assets.${variant}.initramfs} $out/runtime-${variant}.cpio`));
    assert.ok(
      recipe.includes(`cp \${builtins.head assets.${variant}.disks} $out/root-${variant}.ext4`),
    );
  }
  const report = {
    suites: [
      {
        specs: titles.map((title) => ({
          title,
          tests: [{ status: "expected", results: [{ status: "passed", retry: 0 }] }],
        })),
      },
    ],
    stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
    errors: [],
  };
  checkReport(report, titles);
  for (const title of titles) {
    const missing = structuredClone(report);
    missing.suites[0].specs = missing.suites[0].specs.filter((entry) => entry.title !== title);
    assert.throws(() => checkReport(missing, titles));
  }
});
