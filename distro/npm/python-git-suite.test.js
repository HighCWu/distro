// SPDX-License-Identifier: MIT
// Fast injected-adapter tests, not evidence of an actual Wasm/Linux boot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runtimeAssertions } from "../../packages/browser-tests/agent-assertions.js";

const source = readFileSync(
  new URL(
    "../../packages/linux-guest/tests/agent-wasm64-python-git-root-suite.ts",
    import.meta.url,
  ),
  "utf8",
);
const script = "/root/workspace-example.py";
const example = Uint8Array.of(35, 0, 255, 10);
const payload = Uint8Array.from({ length: 65553 }, (_, i) => i & 255);
const digest = "4de6ff0a51a4cd16f2bb867a3f3ff954ee6509504b64ba03c20eb4b34adf2b81";
class SystemError extends Error {
  code = "ENOENT";
}
const factory = new Function(
  "blockDevice",
  "SystemError",
  "withPersistentRootMachine",
  stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "").replace(/^export /gm, "")) +
    "\nreturn runPythonGitRootWasm64Suite;",
);

async function fixture(fault) {
  const files = new Map();
  const devices = [],
    events = [],
    commands = [];
  let boots = 0,
    closes = 0;
  const ok = (stdout = "") => ({
    status: { success: true, code: 0, signal: null },
    stdout: new TextEncoder().encode(stdout),
    stderr: new Uint8Array(),
  });
  const agent = {
    fs: {
      async stat() {
        throw new SystemError();
      },
      async writeFile(path, bytes) {
        files.set(path, bytes.slice());
      },
      async readFile(path) {
        if (path === script) return fault === "source" ? Uint8Array.of(0) : files.get(path);
        if (path.endsWith(".bin")) {
          if (fault === "clone" && path.includes("clone")) return Uint8Array.of(0);
          return payload.slice();
        }
        return Uint8Array.of(1);
      },
    },
    async run(argv) {
      commands.push(argv);
      if (argv[0] === "git")
        return ok(
          fault === "abi"
            ? "sizeof-long: 4\nsizeof-size_t: 4\n"
            : "sizeof-long: 8\nsizeof-size_t: 8\n",
        );
      if (argv[2] === "-c") return ok("Python Git root ABI OK\n");
      if (argv[2] === script) {
        const phase = argv[3];
        events.push(phase);
        return ok(
          JSON.stringify({
            head: fault === "head" && phase === "read" ? "b".repeat(40) : "a".repeat(40),
            sha256: fault === "digest" ? "0".repeat(64) : digest,
            bytes: payload.byteLength,
            phase,
          }),
        );
      }
      if (argv[0] === "/bin/sync") {
        const device = devices.at(-1);
        device.write(0, Uint8Array.of(boots));
        if (fault !== "flush") device.flush();
      }
      if (fault === "status" && argv[0] === "sha256sum")
        return { ...ok(), status: { success: false, code: 1, signal: null } };
      return ok();
    },
  };
  const run = factory(
    (device) => {
      devices.push(device);
      return device;
    },
    SystemError,
    async (_boot, _device, _assertions, verify) => {
      assert.equal(closes, boots, "previous machine must close before another boot");
      boots++;
      try {
        await verify(agent);
      } finally {
        closes++;
      }
      if (fault === "close") throw new Error("close failed");
    },
  );
  const root = new Uint8Array(8);
  const result = await run(
    new Uint8Array(8),
    root,
    example,
    runtimeAssertions,
    async (_name, body) => body(),
    () => {},
  );
  return { result, boots, closes, root, devices, events, commands };
}

test("shared suite verifies digest, exact argv, two fresh adapters and completed close", async () => {
  const { result, boots, closes, root, devices, events, commands } = await fixture();
  assert.deepEqual(result, {
    passed: [
      "Python Git workspace write through public SDK",
      "Python Git workspace read through public SDK",
    ],
    closed: true,
  });
  assert.equal(boots, 2);
  assert.equal(closes, 2);
  assert.equal(devices.length, 2);
  assert.notEqual(devices[0], devices[1]);
  assert.equal(root[0], 2);
  assert.deepEqual(events, ["write", "read"]);
  assert.deepEqual(
    commands.filter((argv) => argv[2] === script),
    [
      ["python3", "-I", script, "write", "/root/workspace ' $HOME → data"],
      ["python3", "-I", script, "read", "/root/workspace ' $HOME → data", "a".repeat(40)],
    ],
  );
});

test("shared suite rejects corruption, wrong width, failed notices, missing flush and failed close", async () => {
  for (const fault of ["source", "clone", "head", "digest", "abi", "status", "flush", "close"])
    await assert.rejects(fixture(fault), undefined, fault);
});
