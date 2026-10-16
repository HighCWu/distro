// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("./agent-persistent-root-app.js", import.meta.url), "utf8");
const imports = /^import[\s\S]*?from "[^"]+";$/gm;
assert.equal([...source.matchAll(imports)].length, 3);

function harness(overrides = {}, handle = {}) {
  const calls = [];
  const context = {
    Uint8Array,
    console,
    runtimeAssertions: assert,
    navigator: {
      storage: {
        async getDirectory() {
          calls.push("directory");
          return {
            async getFileHandle(name, options) {
              calls.push(["handle", name, options]);
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
      postMessage(message) {
        assert.equal(message.handle, handle);
        assert.deepEqual(Object.keys(message), ["handle"]);
        calls.push("configure");
      }
      terminate() {
        calls.push("terminate");
      }
    },
    async workerDevice() {
      calls.push("device");
      return { closed: Promise.resolve() };
    },
    async withPersistentRootMachine(_image, _device, _assert, verify) {
      calls.push("boot");
      await verify("agent");
      calls.push("closed");
    },
    async readPersistentRoot(agent) {
      assert.equal(agent, "agent");
      calls.push("readback");
    },
    ...overrides,
  };
  runInNewContext(source.replace(imports, ""), context);
  return { run: context.runOpfsNativeRoot, calls };
}

const name = "native-root-0123-abcd.img";

test("OPFS readback reopens existing bytes without fetching or recreating the template", async () => {
  const { run, calls } = harness();
  const result = await run("read", name);
  assert.equal(result.phase, "read");
  assert.equal(result.closed, true);
  assert.deepEqual(calls, [
    "directory",
    ["handle", name, undefined],
    ["fetch", "/agent-boot.img"],
    ["worker", "/opfs-disk-worker.js"],
    "device",
    "configure",
    "boot",
    "readback",
    "closed",
    "terminate",
  ]);
});

test("OPFS initialization refuses an existing disk without overwriting it", async () => {
  const { run, calls } = harness();
  await assert.rejects(run("write", name), /already exists/);
  assert.deepEqual(calls, ["directory", ["handle", name, undefined]]);
});

test("OPFS worker setup failure terminates the worker and preserves the error", async () => {
  const reason = new Error("worker startup failed");
  const { run, calls } = harness({ workerDevice: async () => Promise.reject(reason) });
  await assert.rejects(run("read", name), (error) => error === reason);
  assert.equal(calls.at(-1), "terminate");
  assert.equal(calls.includes("boot"), false);
});

test("OPFS phase and disk name validation precede storage access", async () => {
  const { run, calls } = harness();
  await assert.rejects(run("invalid", name), /invalid persistence phase/);
  await assert.rejects(run("read", "another-disk.img"), /invalid test disk name/);
  assert.deepEqual(calls, []);
});

for (const failWrite of [false, true]) {
  test(`OPFS initialization ${failWrite ? "aborts a failed image write" : "commits the image before opening the worker"}`, async () => {
    const events = [];
    const reason = new Error("image write failed");
    const handle = {
      async createWritable() {
        return {
          async write(bytes) {
            assert.equal(bytes.byteLength, 512);
            events.push("write");
            if (failWrite) throw reason;
          },
          async close() {
            events.push("commit");
          },
          async abort() {
            events.push("abort");
          },
        };
      },
    };
    let lookups = 0;
    const { run, calls } = harness(
      {
        navigator: {
          storage: {
            async getDirectory() {
              return {
                async getFileHandle(_name, options) {
                  lookups++;
                  if (lookups === 1)
                    throw Object.assign(new Error("absent"), { name: "NotFoundError" });
                  assert.equal(options?.create, lookups === 2 ? true : undefined);
                  return handle;
                },
              };
            },
          },
        },
        async writePersistentRoot() {
          events.push("linux-write");
        },
      },
      handle,
    );
    if (failWrite) {
      await assert.rejects(run("write", name), (error) => error === reason);
      assert.deepEqual(events, ["write", "abort"]);
      assert.equal(
        calls.some((call) => Array.isArray(call) && call[0] === "worker"),
        false,
      );
    } else {
      await run("write", name);
      assert.deepEqual(events, ["write", "commit", "linux-write"]);
      assert.equal(lookups, 3);
      assert.equal(calls.at(-1), "terminate");
    }
  });
}
