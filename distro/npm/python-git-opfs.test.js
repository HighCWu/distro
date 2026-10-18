// SPDX-License-Identifier: MIT
// Injected storage/lifecycle checks, not a substitute for the real browser CI.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { checkReport } from "./browser-report-check.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../../packages/browser-tests/agent-python-git-root-app.js");
const spec = read("../../packages/browser-tests/agent-tests/agent-python-git-opfs-root.spec.js");
const recipe = read("./browser-tests.nix");
const title = "persists Python Git SQLite workspace through OPFS across page reload";
const name = "python-git-root-1234-abcd.img";
const head = "a".repeat(40);

function fixture({ exists = false, fault } = {}) {
  const events = [],
    requests = [],
    configurations = [];
  const handle = {
    async createWritable() {
      events.push("create-writable");
      return {
        async write(bytes) {
          events.push("write-template");
          assert.deepEqual(bytes, Uint8Array.of(0, 255));
          if (fault === "write") throw new Error("disk full");
        },
        async close() {
          events.push("close-template");
        },
        async abort() {
          events.push("abort-template");
          throw new Error("abort failed");
        },
      };
    },
  };
  const directory = {
    async getFileHandle(path, options) {
      assert.equal(path, name);
      if (options) {
        assert.equal(JSON.stringify(options), '{"create":true}');
        events.push("create-file");
        exists = true;
      } else events.push("open-file");
      if (!exists) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      return handle;
    },
  };
  const assertions = {};
  const context = {
    Uint8Array,
    console,
    runtimeAssertions: assertions,
    navigator: {
      storage: {
        async getDirectory() {
          events.push("directory");
          return directory;
        },
      },
    },
    fetch: async (path) => {
      requests.push(path);
      return { ok: true, arrayBuffer: async () => Uint8Array.of(0, 255).buffer };
    },
    Worker: class {
      constructor(path, options) {
        assert.equal(path, "/opfs-disk-worker.js");
        assert.equal(options.type, "module");
        events.push("worker");
      }
      terminate() {
        events.push("terminate");
      }
    },
    workerDevice() {},
    openDiskWorker: async (_worker, configuration, connect) => {
      configurations.push(configuration);
      assert.equal(connect, context.workerDevice);
      assert.deepEqual(Object.keys(configuration), ["handle"]);
      assert.equal(configuration.handle, handle);
      return {
        get closed() {
          return Promise.resolve().then(() => {
            events.push("disk-closed");
            if (fault === "disk-close") throw new Error("disk close failed");
          });
        },
      };
    },
    withPythonGitRootMachine: async (_boot, _device, actual, body) => {
      assert.equal(actual, assertions);
      events.push("boot");
      try {
        await body("agent");
      } finally {
        events.push("machine-closed");
      }
      if (fault === "machine-close") throw new Error("machine close failed");
    },
    verifyPythonGitRoot: async (agent, source, phase, expected, actual) => {
      assert.equal(agent, "agent");
      assert.deepEqual(source, Uint8Array.of(0, 255));
      assert.equal(actual, assertions);
      assert.equal(expected, phase === "read" ? head : undefined);
      events.push(`verify-${phase}`);
      if (fault === "verify") throw new Error("workspace corrupt");
      return head;
    },
  };
  runInNewContext(app.replace(/^import[\s\S]*?;\n/gm, ""), context);
  return { run: context.runOpfsPythonGitRoot, events, requests, configurations };
}

test("OPFS write initializes a new disk and waits for machine and disk close before returning HEAD", async () => {
  const f = fixture();
  const result = await f.run("write", name);
  assert.equal(JSON.stringify(result), JSON.stringify({ phase: "write", head, closed: true }));
  assert.deepEqual(f.events, [
    "directory",
    "open-file",
    "create-file",
    "create-writable",
    "write-template",
    "close-template",
    "open-file",
    "worker",
    "boot",
    "verify-write",
    "machine-closed",
    "disk-closed",
    "terminate",
  ]);
  assert.deepEqual(f.requests, [
    "/agent-root.ext4",
    "/agent-boot.img",
    "/git-workspace-example.py",
  ]);
});

test("OPFS read opens existing bytes without template fetch, create, capacity or truncate", async () => {
  const f = fixture({ exists: true });
  const result = await f.run("read", name, head);
  assert.equal(JSON.stringify(result), JSON.stringify({ phase: "read", head, closed: true }));
  assert.deepEqual(f.events, [
    "directory",
    "open-file",
    "worker",
    "boot",
    "verify-read",
    "machine-closed",
    "disk-closed",
    "terminate",
  ]);
  assert.deepEqual(f.requests, ["/agent-boot.img", "/git-workspace-example.py"]);
});

test("existing write and missing read fail without disk writes, template fetch or boot", async () => {
  for (const [exists, phase] of [
    [true, "write"],
    [false, "read"],
  ]) {
    const f = fixture({ exists });
    await assert.rejects(f.run(phase, name, phase === "read" ? head : undefined));
    assert.deepEqual(f.events, ["directory", "open-file"]);
    assert.deepEqual(f.requests, []);
  }
});

test("invalid phase, disk name or original HEAD fails before storage access", async () => {
  for (const args of [
    ["other", name],
    ["write", "../disk"],
    ["read", name],
    ["read", name, "bad"],
    ["write", name, head],
  ]) {
    const f = fixture();
    await assert.rejects(f.run(...args));
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.requests, []);
  }
});

test("template write abort preserves original error; verification and close failures never return success", async () => {
  const failed = fixture({ fault: "write" });
  await assert.rejects(failed.run("write", name), /disk full/);
  assert.equal(failed.events.at(-1), "abort-template");
  assert.ok(!failed.events.includes("worker"));
  for (const fault of ["verify", "machine-close", "disk-close"]) {
    const f = fixture({ exists: true, fault });
    await assert.rejects(f.run("read", name, head));
    assert.equal(f.events.at(-1), "terminate");
    assert.ok(f.events.includes("machine-closed"));
  }
});

test("OPFS browser check has independent exact-case gates and includes worker assets", () => {
  for (const browser of ["chromium", "firefox"])
    assert.ok(recipe.includes(`"agent-python-git-opfs-root-wasm64-${browser}"`));
  for (const required of [
    `"${title}"`,
    "suite = pythonGitRootSuite true;",
    "cp ${opfsWorker}/opfs-disk-worker.js $out/opfs-disk-worker.js",
    "cp ${../../apps/site/opfs-device.js} $out/opfs-device.js",
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
      r.stats.skipped = 1;
    },
    (r) => {
      r.suites[0].specs[0].tests[0].results[0].retry = 1;
    },
    (r) => {
      r.suites[0].specs[0].title = "different";
    },
  ]) {
    const bad = structuredClone(report);
    mutate(bad);
    assert.throws(() => checkReport(bad, [title]));
  }
});

test("actual OPFS browser case carries original HEAD across reload, blocks template and cleans exact disk", async () => {
  for (const badHead of [false, true]) {
    const events = [];
    let body;
    const expect = (value) => ({
      toBe: (wanted) => assert.equal(value, wanted),
      toMatch: (regex) => assert.match(value, regex),
      toEqual: (wanted) => assert.equal(JSON.stringify(value), JSON.stringify(wanted)),
    });
    expect.poll = (fn) => ({ toBe: async (wanted) => assert.equal(await fn(), wanted) });
    const context = {
      console,
      expect,
      crossOriginIsolated: true,
      crypto: { randomUUID: () => "1234-abcd" },
      test: (actual, fn) => {
        assert.equal(actual, title);
        body = fn;
      },
      runOpfsPythonGitRoot: async (phase, actual, expected) => {
        assert.equal(actual, name);
        assert.equal(expected, phase === "read" ? head : undefined);
        events.push(phase);
        return { phase, head: badHead && phase === "read" ? "b".repeat(40) : head, closed: true };
      },
      navigator: {
        storage: {
          getDirectory: async () => ({
            removeEntry: async (actual) => {
              assert.equal(actual, name);
              events.push("remove");
            },
          }),
        },
      },
    };
    runInNewContext(spec.replace(/^import .*;\n/gm, ""), context);
    const page = {
      on() {},
      goto: async () => {},
      evaluate: async (fn, arg) => {
        context.arg = arg;
        return runInNewContext(`(${fn.toString()})(arg)`, context);
      },
      reload: async () => events.push("reload"),
      route: async (pattern, fn) => {
        assert.equal(pattern, "**/agent-root.ext4");
        await fn({ abort: async () => events.push("block-template") });
      },
    };
    if (badHead) await assert.rejects(body({ page }));
    else await body({ page });
    assert.deepEqual(events, ["write", "reload", "block-template", "read", "remove"]);
  }
});
