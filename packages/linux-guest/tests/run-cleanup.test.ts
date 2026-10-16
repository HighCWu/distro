// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { collect_run_result } from "../src/run.ts";
import type { CommandStatus } from "../src/process.ts";

const success: CommandStatus = { success: true, code: 0, signal: null };
const bytes = (data: number[] = []) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      if (data.length) controller.enqueue(Uint8Array.from(data));
      controller.close();
    },
  });

function fixture(
  options: {
    status?: Promise<CommandStatus>;
    stdout?: ReadableStream<Uint8Array>;
    inputError?: unknown;
    cleanup?: () => Promise<void>;
  } = {},
) {
  let closes = 0;
  let inputClosed = false;
  return {
    status: options.status ?? Promise.resolve(success),
    stdout: options.stdout ?? bytes([0, 255, 1]),
    stderr: bytes([17, 0]),
    stdin: new WritableStream<Uint8Array>({
      close() {
        inputClosed = true;
        if (options.inputError) throw options.inputError;
      },
    }),
    async close() {
      closes++;
      await options.cleanup?.();
    },
    get closes() {
      return closes;
    },
    get inputClosed() {
      return inputClosed;
    },
  };
}

test("run collects exact binary outputs, sends EOF and disposes its child", async () => {
  const child = fixture();
  const result = await collect_run_result(child);
  assert.deepEqual(result, {
    status: success,
    stdout: Uint8Array.of(0, 255, 1),
    stderr: Uint8Array.of(17, 0),
  });
  assert.equal(child.inputClosed, true);
  assert.equal(child.closes, 1);
});

test("nonzero exit remains a result and still disposes the child", async () => {
  const status = { success: false, code: 23, signal: null };
  const child = fixture({ status: Promise.resolve(status) });
  assert.deepEqual((await collect_run_result(child)).status, status);
  assert.equal(child.closes, 1);
});

test("output failure disposes before reporting the primary error", async () => {
  const error = new Error("stdout failed");
  let finish!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let finishStatus!: (status: CommandStatus) => void;
  const status = new Promise<CommandStatus>((resolve) => {
    finishStatus = resolve;
  });
  const child = fixture({
    status,
    stdout: new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    cleanup: () => {
      finishStatus(success);
      return cleanup;
    },
  });
  let settled = false;
  const result = collect_run_result(child);
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await setImmediate();
    assert.equal(child.closes, 1);
    assert.equal(settled, false);
  } finally {
    finish();
    await assert.rejects(result, (actual) => actual === error);
  }
});

test("status rejection and stdin close failure both trigger disposal", async () => {
  for (const source of ["status", "stdin"]) {
    const error = new Error(source);
    const child = fixture(
      source === "status" ? { status: Promise.reject(error) } : { inputError: error },
    );
    await assert.rejects(collect_run_result(child), (actual) => actual === error);
    assert.equal(child.closes, 1);
  }
});

test("cleanup failure after success is reported", async () => {
  const error = new Error("cleanup failed");
  const child = fixture({
    cleanup: async () => {
      throw error;
    },
  });
  await assert.rejects(collect_run_result(child), (actual) => actual === error);
});

test("simultaneous execution and cleanup errors retain both failures", async () => {
  const error = new Error("execution failed");
  const cleanupError = new Error("cleanup failed");
  const child = fixture({
    status: Promise.reject(error),
    cleanup: async () => {
      throw cleanupError;
    },
  });
  await assert.rejects(collect_run_result(child), (actual) => {
    assert.ok(actual instanceof AggregateError);
    assert.deepEqual(actual.errors, [error, cleanupError]);
    assert.equal(actual.cause, error);
    return true;
  });
});
