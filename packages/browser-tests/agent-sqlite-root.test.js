// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./agent-sqlite-root-app.js", import.meta.url), "utf8");
const imports = /^import[\s\S]*?from "[^"]+";$/gm;
assert.equal([...source.matchAll(imports)].length, 4);

function harness({ existing = true, writeFailure, deviceFailure } = {}) {
  const calls = [];
  let created = existing;
  const handle = {
    async createWritable() {
      return {
        async write() {
          calls.push("write-image");
          if (writeFailure) throw writeFailure;
        },
        async close() {
          calls.push("commit-image");
        },
        async abort() {
          calls.push("abort-image");
        },
      };
    },
  };
  const context = {
    console,
    Uint8Array,
    runtimeAssertions: assert,
    navigator: {
      storage: {
        async getDirectory() {
          return {
            async getFileHandle(name, options) {
              calls.push(["handle", name, options?.create]);
              if (!created && !options?.create)
                throw Object.assign(new Error("absent"), { name: "NotFoundError" });
              created = true;
              return handle;
            },
          };
        },
      },
    },
    async fetch(path) {
      calls.push(["fetch", path]);
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(512) };
    },
    Worker: class {
      constructor(path) {
        calls.push(["worker", path]);
      }
      terminate() {
        calls.push("terminate");
      }
    },
    async openDiskWorker(_worker, configuration) {
      assert.equal(configuration.handle, handle);
      assert.deepEqual(Object.keys(configuration), ["handle"]);
      calls.push("open-device");
      if (deviceFailure) throw deviceFailure;
      return { closed: Promise.resolve() };
    },
    workerDevice() {},
    async withPersistentRootMachine(_boot, _device, _assert, verify) {
      calls.push("boot");
      await verify("agent");
      calls.push("machine-closed");
    },
    async verifySqliteRoot(agent, phase) {
      assert.equal(agent, "agent");
      calls.push(["sqlite", phase]);
    },
  };
  runInNewContext(source.replace(imports, ""), context);
  return { run: context.runOpfsSqliteRoot, calls };
}
const name = "sqlite-root-0123-abcd.img";

test("SQLite OPFS read opens existing bytes without fetching or recreating the root", async () => {
  const { run, calls } = harness();
  assert.equal((await run("read", name)).closed, true);
  assert.deepEqual(calls, [
    ["handle", name, undefined],
    ["fetch", "/agent-boot.img"],
    ["worker", "/opfs-disk-worker.js"],
    "open-device",
    "boot",
    ["sqlite", "read"],
    "machine-closed",
    "terminate",
  ]);
});
test("SQLite OPFS setup refuses overwrite and validates arguments before storage access", async () => {
  const { run, calls } = harness();
  await assert.rejects(run("bad", name), /invalid SQLite persistence phase/);
  await assert.rejects(run("write", "other.img"), /invalid SQLite disk name/);
  assert.deepEqual(calls, []);
  await assert.rejects(run("write", name), /already exists/);
  assert.deepEqual(calls, [["handle", name, undefined]]);
});
test("SQLite OPFS initialization commits its image before opening Linux", async () => {
  const { run, calls } = harness({ existing: false });
  await run("write", name);
  assert.ok(calls.indexOf("commit-image") < calls.indexOf("open-device"));
  assert.ok(calls.indexOf("commit-image") >= 0);
  assert.ok(
    calls.some((entry) => Array.isArray(entry) && entry[0] === "sqlite" && entry[1] === "write"),
  );
});
test("SQLite OPFS image-write and device failures preserve errors without continuing to Linux", async () => {
  for (const kind of ["writeFailure", "deviceFailure"]) {
    const reason = new Error(kind);
    const { run, calls } = harness({ existing: false, [kind]: reason });
    await assert.rejects(run("write", name), (error) => error === reason);
    assert.equal(calls.includes("boot"), false);
    assert.equal(calls.includes(kind === "writeFailure" ? "abort-image" : "terminate"), true);
  }
});
