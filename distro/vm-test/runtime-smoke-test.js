// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { captureProfileOutput } from "../fork-continuation/benchmark-profile-capture.js";

const source = readFileSync(
  new URL("../../packages/browser-tests/runtime-smoke.js", import.meta.url),
  "utf8",
).replace('"./protocol.js"', JSON.stringify(new URL("./protocol.js", import.meta.url).href));
const { runRuntimeSmoke } = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

function fixture(
  lines,
  {
    bootDelay = false,
    closeConsole = false,
    bootLines = [],
    closeError,
    closeDelay = false,
    expectedCpus = 2,
  } = {},
) {
  let writer;
  let closed = false;
  let releaseBoot;
  let resolveClosed;
  let rejectClosed;
  const finishClose = () => (closeError ? rejectClosed(closeError) : resolveClosed());
  const machine = {
    bootConsole: new ReadableStream({
      start(controller) {
        for (const line of bootLines) controller.enqueue(new TextEncoder().encode(line));
        controller.close();
      },
    }),
    closed: new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    }),
    close() {
      closed = true;
      if (!closeDelay) finishClose();
    },
  };
  return {
    finishClose,
    write: (line) => writer.write(new TextEncoder().encode(line)),
    abort: (error) => writer.abort(error),
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
        assert.equal(options.cpus, expectedCpus);
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

test("explicit one-CPU profiles and the existing two-CPU profiles both await shutdown", async () => {
  for (const cpus of [1, 2]) {
    const state = fixture(["::vm-test::pass\n"], { expectedCpus: cpus });
    assert.match(await runRuntimeSmoke({ ...state.options, cpus }), /::vm-test::pass/);
    assert.equal(state.closed, true);
  }
});

test("host diagnostics complete after user pass even when the boot console is already closed", async () => {
  const state = fixture(["::vm-test::pass\n"]);
  let complete;
  const additionalCompletion = new Promise((resolve) => {
    complete = resolve;
  });
  const check = runRuntimeSmoke({
    ...state.options,
    timeoutMs: 1000,
    additionalCompletion,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.closed, false);
  complete();
  assert.match(await check, /::vm-test::pass/);
  assert.equal(state.closed, true);
});

test("a missing or rejected diagnostic promise cannot bypass the watchdog or cleanup", async () => {
  for (const makeCompletion of [
    () => new Promise(() => {}),
    () => Promise.reject(Error("broken diagnostic gate")),
  ]) {
    const state = fixture(["::vm-test::pass\n"]);
    await assert.rejects(
      runRuntimeSmoke({ ...state.options, additionalCompletion: makeCompletion() }),
      /timed out|broken diagnostic gate/,
    );
    assert.equal(state.closed, true);
  }
});

test("user failures still reject promptly while diagnostics are pending", async () => {
  const state = fixture(["::vm-test::pass\n"]);
  const check = runRuntimeSmoke({
    ...state.options,
    timeoutMs: 1000,
    additionalCompletion: new Promise(() => {}),
  });
  const rejected = assert.rejects(check, /late user failure/);
  await new Promise((resolve) => setImmediate(resolve));
  await state.write("::vm-test::fail: late user failure\n");
  await rejected;
  assert.equal(state.closed, true);
});

test("real Worker diagnostics wake the host gate independently of the closed Linux boot stream", async () => {
  const logger = {
    error() {
      throw Error("unexpected non-diagnostic output");
    },
  };
  const capture = captureProfileOutput(true, 1, logger);
  const worker = new Worker(
    'const {parentPort}=require("node:worker_threads");parentPort.once("message",line=>parentPort.postMessage(line));',
    { eval: true },
  );
  worker.on("message", (line) => logger.error(line));
  try {
    const state = fixture(["::vm-test::pass\n"]);
    const check = runRuntimeSmoke({
      ...state.options,
      timeoutMs: 1000,
      additionalCompletion: capture.completion,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, false);
    worker.postMessage('fork-profile: {"request":"late-worker"}');
    assert.match(await check, /::vm-test::pass/);
    assert.equal(capture.lines.length, 1);
    assert.equal(state.closed, true);
  } finally {
    capture.restore();
    await worker.terminate();
  }
});

test("requires a complete user-program pass marker, not the kernel banner", async () => {
  const positive = fixture(["Linux version test\n", "::vm-test::pa", "ss\n"]);
  assert.match(await runRuntimeSmoke(positive.options), /::vm-test::pass/);
  assert.equal(positive.closed, true);
  const bannerOnly = fixture(["Linux version test\n"]);
  await assert.rejects(runRuntimeSmoke(bannerOnly.options), /timed out/);
  assert.equal(bannerOnly.closed, true);
});

test("live diagnostics identify boot, console and shutdown without altering returned output", async () => {
  const state = fixture(["::vm-test::pass\n"]);
  const events = [];
  const output = await runRuntimeSmoke({
    ...state.options,
    onProgress: (event) => events.push(event),
  });
  assert.match(output, /::vm-test::pass/);
  for (const event of [
    "loading initramfs",
    "boot requested",
    "boot returned",
    "user: ::vm-test::pass",
    "user result received",
    "shutdown requested",
    "shutdown completed",
  ])
    assert.ok(events.includes(event), event);
  assert.equal(events.at(-1), "shutdown completed");
  const throwing = fixture(["::vm-test::pass\n"]);
  assert.match(
    await runRuntimeSmoke({
      ...throwing.options,
      onProgress() {
        throw new Error("diagnostic failure");
      },
    }),
    /::vm-test::pass/,
  );
  assert.equal(throwing.closed, true);
});

test("live diagnostics cannot replace a missing user result", async () => {
  const state = fixture([]);
  const events = [];
  await assert.rejects(
    runRuntimeSmoke({ ...state.options, onProgress: (event) => events.push(event) }),
    /timed out/,
  );
  assert.ok(events.includes("user runtime timed out"));
  assert.equal(state.closed, true);
});

test("early unreasoned console abort cannot hide later machine failure diagnostics", async () => {
  const state = fixture([], { closeDelay: true, closeError: new Error("original Worker failure") });
  const events = [];
  const check = runRuntimeSmoke({ ...state.options, onProgress: (event) => events.push(event) });
  const rejected = assert.rejects(check, /undefined/);
  await new Promise((resolve) => setImmediate(resolve));
  await state.abort(undefined);
  await new Promise((resolve) => setImmediate(resolve));
  state.finishClose();
  await rejected;
  assert.ok(events.some((event) => event === "runtime failure: undefined"));
  assert.ok(
    events.some((event) => event.includes("runtime failure: Error: original Worker failure")),
  );
  assert.equal(state.closed, true);
});

test("a user-program pass waits for successful device shutdown", async () => {
  const state = fixture(["::vm-test::pass\n"], { closeDelay: true });
  let settled = false;
  const check = runRuntimeSmoke(state.options).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.closed, true, "shutdown must have started");
  assert.equal(settled, false, "a pass cannot bypass pending storage shutdown");
  state.finishClose();
  assert.match(await check, /::vm-test::pass/);
});

test("a shutdown rejection overrides a user-program pass", async () => {
  const closeError = new Error("storage flush failed");
  const state = fixture(["::vm-test::pass\n"], { closeError });
  await assert.rejects(runRuntimeSmoke(state.options), (error) => error === closeError);
  assert.equal(state.closed, true);
});

test("a failed program retains its preceding console traceback in the reported error", async () => {
  const state = fixture([
    "Python stage before failure\nTraceback (most recent call last):\n",
    "AssertionError: concrete failure\n::vm-test::fa",
    "il\n",
  ]);
  await assert.rejects(runRuntimeSmoke(state.options), (error) => {
    assert.match(error.message, /guest reported failure/);
    assert.match(error.message, /Runtime console:/);
    assert.match(error.message, /Python stage before failure/);
    assert.match(error.message, /Traceback \(most recent call last\):/);
    assert.match(error.message, /AssertionError: concrete failure/);
    assert.match(error.message, /::vm-test::fail/);
    return true;
  });
  assert.equal(state.closed, true);
});

test("a pass cannot hide a later failure or panic in the same console stream", async () => {
  for (const lines of [
    ["::vm-test::pass\n::vm-test::fail: failure after pass\n"],
    ["::vm-test::pass\n", "::vm-test::fail: failure after pass\n"],
    ["::vm-test::pass\n", "Kernel panic - not syncing: failure after pass\n"],
  ]) {
    const state = fixture(lines);
    await assert.rejects(runRuntimeSmoke(state.options), /failure after pass/);
    assert.equal(state.closed, true);
  }
});

test("failures during pending shutdown override a provisional pass", async () => {
  for (const tail of [
    "::vm-test::fail: shutdown failure\n",
    "Kernel panic - not syncing: shutdown failure\n",
  ]) {
    const state = fixture(["::vm-test::pass\n"], { closeDelay: true });
    const check = runRuntimeSmoke(state.options);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(state.closed, true);
    await state.write(tail);
    state.finishClose();
    await assert.rejects(check, /shutdown failure/);
  }
});

test("runtime output includes diagnostics received before shutdown completes", async () => {
  const state = fixture(["::vm-test::pass\n"], { closeDelay: true });
  const check = runRuntimeSmoke(state.options);
  await new Promise((resolve) => setImmediate(resolve));
  await state.write("late shutdown diagnostics\n");
  state.finishClose();
  assert.match(await check, /late shutdown diagnostics/);
});

test("intentional console abort is allowed but named errors and buffered failures are not", async () => {
  for (const [tail, reason, expected] of [
    ["", undefined, undefined],
    ["", new Error("console shutdown error"), /console shutdown error/],
    ["::vm-test::fail: buffered failure", undefined, /buffered failure/],
  ]) {
    const state = fixture(["::vm-test::pass\n"], { closeDelay: true });
    const check = runRuntimeSmoke(state.options);
    await new Promise((resolve) => setImmediate(resolve));
    if (tail) await state.write(tail);
    await state.abort(reason);
    state.finishClose();
    if (expected) await assert.rejects(check, expected);
    else assert.match(await check, /::vm-test::pass/);
  }
});

test("the watchdog also bounds a pending shutdown after a program pass", async () => {
  const state = fixture(["::vm-test::pass\n"], { closeDelay: true });
  await assert.rejects(runRuntimeSmoke(state.options), /runtime shutdown timed out/);
  assert.equal(state.closed, true);
  state.finishClose();
});

test("a stuck shutdown cannot indefinitely postpone a program failure", async () => {
  const state = fixture(["::vm-test::fail: original failure\n"], { closeDelay: true });
  await assert.rejects(runRuntimeSmoke(state.options), /original failure/);
  assert.equal(state.closed, true);
  state.finishClose();
});

test("shutdown failure does not hide a program failure or watchdog timeout", async () => {
  for (const [lines, expected] of [
    [["::vm-test::fail: database recovery failed\n"], /database recovery failed/],
    [[], /timed out/],
  ]) {
    const state = fixture(lines, { closeError: new Error("cleanup also failed") });
    await assert.rejects(runRuntimeSmoke(state.options), expected);
    assert.equal(state.closed, true);
  }
});

test("a late machine shutdown rejection cannot replace the watchdog failure", async () => {
  const state = fixture([], { bootDelay: true, closeError: new Error("late close failed") });
  await assert.rejects(runRuntimeSmoke(state.options), /timed out/);
  state.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.closed, true);
});

test("boot-console result markers cannot substitute for user-program completion", async () => {
  const state = fixture([], { bootLines: ["::vm-test::pass\n"] });
  await assert.rejects(runRuntimeSmoke(state.options), /timed out/);
  assert.equal(state.closed, true);
});

test("kernel panic on the boot console fails the runtime check", async () => {
  const state = fixture([], { bootLines: ["Kernel panic - not syncing: broken\n"] });
  await assert.rejects(runRuntimeSmoke(state.options), /Kernel panic/);
  assert.equal(state.closed, true);
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
