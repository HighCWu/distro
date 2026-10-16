// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { openDiskWorker } from "./opfs-device.js";

function harness({ failPost, failConnect, ready = false, failTerminate = false } = {}) {
  const closed = Promise.withResolvers();
  const device = { closed: closed.promise };
  let startupSignal;
  let accept;
  const worker = {
    terminated: 0,
    messages: [],
    postMessage(message) {
      if (failPost) throw failPost;
      this.messages.push(message);
      if (ready) accept(device);
    },
    terminate() {
      this.terminated++;
      if (failTerminate) throw new Error("termination failed");
    },
  };
  const connect = (_worker, { signal }) => {
    assert.equal(_worker, worker);
    startupSignal = signal;
    if (failConnect) return Promise.reject(failConnect);
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      accept = (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  };
  return { worker, connect, closed, device, signal: () => startupSignal };
}

test("disk startup timeout cancels the pending handshake and terminates its worker", async () => {
  const h = harness();
  await assert.rejects(openDiskWorker(h.worker, {}, h.connect, { timeoutMs: 5 }), {
    name: "TimeoutError",
  });
  assert.equal(h.worker.terminated, 1);
  assert.equal(h.signal().aborted, true);
  assert.equal(getEventListeners(h.signal(), "abort").length, 0);
});

test("postMessage and connection failures preserve their primary error and clean up", async () => {
  for (const kind of ["failPost", "failConnect"]) {
    const reason = new Error(kind);
    const h = harness({ [kind]: reason, failTerminate: true });
    await assert.rejects(openDiskWorker(h.worker, {}, h.connect), (e) => e === reason);
    assert.equal(h.worker.terminated, 1);
    assert.equal(h.signal().aborted, true);
    assert.equal(getEventListeners(h.signal(), "abort").length, 0);
  }
});

test("caller abort before and during startup releases its signal listener", async () => {
  for (const preAborted of [true, false]) {
    const h = harness();
    const controller = new AbortController();
    const reason = { stop: true };
    if (preAborted) controller.abort(reason);
    const pending = openDiskWorker(h.worker, {}, h.connect, { signal: controller.signal });
    if (!preAborted) controller.abort(reason);
    await assert.rejects(pending, (e) => e === reason);
    assert.equal(h.worker.messages.length, preAborted ? 0 : 1);
    assert.equal(h.worker.terminated, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("a ready worker outlives startup abort and terminates only after device closure", async () => {
  for (const failedClose of [false, true]) {
    const h = harness({ ready: true });
    const controller = new AbortController();
    const configuration = { handle: {}, capacity: undefined };
    assert.equal(
      await openDiskWorker(h.worker, configuration, h.connect, { signal: controller.signal }),
      h.device,
    );
    assert.equal(h.worker.messages[0], configuration);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    assert.equal(h.worker.terminated, 0);
    if (failedClose) h.closed.reject(new Error("flush failed"));
    else h.closed.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.worker.terminated, 1);
  }
});

test("invalid startup deadlines still release worker ownership", async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 2147483648]) {
    const h = harness();
    await assert.rejects(openDiskWorker(h.worker, {}, h.connect, { timeoutMs }), RangeError);
    assert.equal(h.worker.terminated, 1);
    assert.deepEqual(h.worker.messages, []);
  }
});
