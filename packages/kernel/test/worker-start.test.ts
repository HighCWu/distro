// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { WorkerHandle } from "../src/platform.ts";
import { post_worker_init, terminate_workers } from "../src/worker-start.ts";

test("shutdown waits for remaining workers after a termination rejection", async () => {
  const failure = new Error("termination failed");
  let release!: () => void;
  const slow = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settled = false;
  const shutdown = terminate_workers([
    {
      post() {},
      terminate: async () => {
        throw failure;
      },
    },
    { post() {}, terminate: () => slow },
  ]);
  void shutdown.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  release();
  await assert.rejects(shutdown, (error) => error === failure);
});

test("synchronous termination errors do not skip subsequent workers", async () => {
  const failure = new Error("synchronous termination failure");
  let attempted = false;
  await assert.rejects(
    terminate_workers([
      {
        post() {},
        terminate() {
          throw failure;
        },
      },
      {
        post() {},
        async terminate() {
          attempted = true;
        },
      },
    ]),
    (error) => error === failure,
  );
  assert.equal(attempted, true);
  await terminate_workers([]);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("successful init retains worker ownership and forwards transfer list", () => {
  const message = {};
  const transfer: Transferable[] = [];
  const workers = new Set<WorkerHandle>();
  const worker: WorkerHandle = {
    post(value, list) {
      assert.equal(value, message);
      assert.equal(list, transfer);
    },
    async terminate() {
      assert.fail("successful worker was terminated");
    },
  };
  post_worker_init(workers, worker, message, transfer);
  assert.equal(workers.has(worker), true);
});

test("failed initialization preserves its error and cleans up the worker", async () => {
  const failure = new Error("transfer failed");
  let terminated = 0;
  const workers = new Set<WorkerHandle>();
  const worker: WorkerHandle = {
    post() {
      throw failure;
    },
    async terminate() {
      terminated++;
    },
  };
  assert.throws(
    () => post_worker_init(workers, worker, {}),
    (error) => error === failure,
  );
  await flush();
  assert.equal(terminated, 1);
  assert.equal(workers.size, 0);
});

test("termination failures retain ownership without replacing the init error", async () => {
  for (const synchronous of [false, true]) {
    const failure = new Error("init failed");
    const workers = new Set<WorkerHandle>();
    const worker: WorkerHandle = {
      post() {
        throw failure;
      },
      terminate() {
        if (synchronous) throw new Error("termination failed");
        return Promise.reject(new Error("termination failed"));
      },
    };
    assert.throws(
      () => post_worker_init(workers, worker, {}),
      (error) => error === failure,
    );
    await flush();
    assert.equal(workers.has(worker), true);
  }
});

test(
  "a real Worker is terminated after a structured-clone failure",
  { timeout: 5000 },
  async (context) => {
    const native = new Worker(
      "require('node:worker_threads').parentPort.on('message', () => {});",
      {
        eval: true,
      },
    );
    context.after(() => native.terminate());
    const exited = new Promise((resolve) => native.once("exit", resolve));
    const workers = new Set<WorkerHandle>();
    const worker: WorkerHandle = {
      post(message) {
        native.postMessage(message);
      },
      async terminate() {
        await native.terminate();
      },
    };
    assert.throws(() => post_worker_init(workers, worker, () => {}), { name: "DataCloneError" });
    await exited;
    await flush();
    assert.equal(workers.size, 0);
  },
);
