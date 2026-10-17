// SPDX-License-Identifier: MIT
// Browser orchestration substitutes only; not kernel or browser execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { LineDecoder, parseResult } from "../../distro/vm-test/protocol.js";

const source = readFileSync(new URL("./erofs-app.js", import.meta.url), "utf8").replace(
  /^import .*;\n/gm,
  "",
);
function harness(marker = "::vm-test::pass", fetchOk = true) {
  const fetched = [];
  let options,
    output,
    closed = 0,
    resolveClosed;
  const machine = {
    bootConsole: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    closed: new Promise((resolve) => {
      resolveClosed = resolve;
    }),
    close() {
      closed++;
      resolveClosed();
    },
  };
  const context = {
    LineDecoder,
    parseResult,
    Uint8Array,
    WritableStream,
    TransformStream,
    setTimeout,
    clearTimeout,
    console: { log() {} },
    fetch: async (path) => {
      fetched.push(path);
      return {
        ok: fetchOk,
        status: 503,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    },
    blockDevice: (device) => ({ kind: "ordinary", ...device }),
    snapshot_block_device: (image) => ({ kind: "snapshot", image }),
    entropyDevice: () => ({ kind: "entropy" }),
    consoleDevice: (_input, sink) => {
      output = sink;
      return { kind: "console" };
    },
    bootMachine: async (value) => {
      options = value;
      const writer = output.getWriter();
      await writer.write(new TextEncoder().encode(`${marker}\n`));
      writer.releaseLock();
      return machine;
    },
  };
  vm.runInNewContext(source, context);
  return {
    run: context.runErofsCopies,
    fetched,
    get options() {
      return options;
    },
    get closed() {
      return closed;
    },
  };
}

for (const [scenario, asset] of [
  ["copies", "erofs"],
  ["errors", "erofs-errors"],
  ["standard", "file-mmap"],
  ["zstd", "zstd-mmap"],
]) {
  test(`${scenario} loads its own artifacts and closes its machine`, async () => {
    const state = harness();
    const result = await state.run(scenario);
    assert.deepEqual(state.fetched, [`/${asset}.cpio`, `/${asset}.img`]);
    assert.equal(result.scenario, scenario);
    assert.equal(result.passed, true);
    assert.equal(result.machineClosed, true);
    assert.equal(state.closed, 1);
    const plugins = state.options.plugins;
    assert.equal(plugins.filter((plugin) => plugin.kind === "snapshot").length, 1);
    const ordinary = plugins.find((plugin) => plugin.kind === "ordinary");
    assert.equal(Boolean(ordinary), scenario !== "errors");
    if (ordinary) {
      const bytes = new Uint8Array(2);
      assert.equal(ordinary.read(1, bytes), 2);
      assert.deepEqual([...bytes], [2, 3]);
      assert.equal(ordinary.write, undefined);
    }
  });
}

test("unknown scenarios fail before fetching or booting", async () => {
  const state = harness();
  await assert.rejects(state.run("unknown"), /unknown EROFS/);
  assert.equal(state.fetched.length, 0);
  assert.equal(state.options, undefined);
});

for (const marker of ["::vm-test::fail: expected refusal", "Kernel panic - not syncing: fixture"]) {
  test(`${marker} cannot become browser success`, async () => {
    const state = harness(marker);
    await assert.rejects(state.run("zstd"), /expected refusal|Kernel panic/);
    // Even failure reported during asynchronous boot must close late Workers.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, 1);
  });
}

test("failed artifact download never starts a machine", async () => {
  const state = harness(undefined, false);
  await assert.rejects(state.run("standard"), /failed to load/);
  assert.equal(state.options, undefined);
  assert.equal(state.closed, 0);
});
