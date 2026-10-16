// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../../packages/browser-tests/runtime-smoke.js", import.meta.url),
  "utf8",
).replace('"./protocol.js"', JSON.stringify(new URL("./protocol.js", import.meta.url).href));
const { runRuntimeSmoke } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

function fixture(lines, { bootDelay = false, closeConsole = false } = {}) {
  let writer;
  let closed = false;
  let releaseBoot;
  let resolveClosed;
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
      closed = true;
      resolveClosed();
    },
  };
  return {
    get closed() {
      return closed;
    },
    release() {
      releaseBoot();
    },
    options: {
      timeoutMs: 30,
      loadInitramfs: async () => new Uint8Array([1]),
      consoleDevice(_input, output) {
        writer = output.getWriter();
        return {};
      },
      entropyDevice: () => ({}),
      async bootMachine(options) {
        assert.equal(options.cpus, 2);
        assert.deepEqual(options.initcpio, new Uint8Array([1]));
        if (bootDelay)
          await new Promise((resolve) => {
            releaseBoot = resolve;
          });
        for (const line of lines) await writer.write(new TextEncoder().encode(line));
        if (closeConsole) await writer.close();
        return machine;
      },
    },
  };
}

test("requires a complete user-program pass marker, not the kernel banner", async () => {
  const positive = fixture(["Linux version test\n", "::vm-test::pa", "ss\n"]);
  assert.match(await runRuntimeSmoke(positive.options), /::vm-test::pass/);
  assert.equal(positive.closed, true);
  const bannerOnly = fixture(["Linux version test\n"]);
  await assert.rejects(runRuntimeSmoke(bannerOnly.options), /timed out/);
  assert.equal(bannerOnly.closed, true);
});

test("propagates program failure, panic and premature console closure", async () => {
  for (const [lines, closeConsole, expected] of [
    [["::vm-test::fail: mmap failed\n"], false, /mmap failed/],
    [["Kernel panic - not syncing: broken\n"], false, /Kernel panic/],
    [[], true, /console closed/],
  ]) {
    const state = fixture(lines, { closeConsole });
    await assert.rejects(runRuntimeSmoke(state.options), expected);
    assert.equal(state.closed, true);
  }
});

test("closes a machine whose boot completes after the watchdog", async () => {
  const state = fixture([], { bootDelay: true });
  await assert.rejects(runRuntimeSmoke(state.options), /timed out/);
  state.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.closed, true);
});
