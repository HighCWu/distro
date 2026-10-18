// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { WorkerHandle } from "../src/platform.ts";
import { discard_worker, post_worker_init, terminate_workers } from "../src/worker-start.ts";

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

test("discard retains ownership until a delayed termination completes", async () => {
  let release!: () => void;
  const worker: WorkerHandle = {
    post() {},
    terminate: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  };
  const workers = new Set([worker]);
  const discarded = discard_worker(workers, worker);
  await flush();
  assert.equal(workers.has(worker), true);
  release();
  await discarded;
  assert.equal(workers.size, 0);
});

test("failed discard remains owned for shutdown retry without affecting a later worker", async () => {
  for (const synchronous of [false, true]) {
    const failure = new Error("injected termination failure");
    let attempts = 0;
    const broken: WorkerHandle = {
      post() {},
      terminate() {
        if (++attempts === 1) {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        }
        return Promise.resolve();
      },
    };
    let freshStops = 0;
    const fresh: WorkerHandle = {
      post() {},
      async terminate() {
        freshStops++;
      },
    };
    const workers = new Set([broken]);
    await assert.rejects(discard_worker(workers, broken), (error) => error === failure);
    assert.equal(workers.has(broken), true);
    post_worker_init(workers, fresh, {});
    assert.equal(workers.size, 2);
    assert.equal(freshStops, 0);
    await terminate_workers(workers);
    assert.equal(attempts, 2);
    assert.equal(freshStops, 1);
  }
});

test("failed init retains a worker during cleanup and permits independent later init", async () => {
  const failure = new Error("injected init failure");
  let release!: () => void;
  const broken: WorkerHandle = {
    post() {
      throw failure;
    },
    terminate: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  };
  const fresh: WorkerHandle = { post() {}, async terminate() {} };
  const workers = new Set<WorkerHandle>();
  assert.throws(
    () => post_worker_init(workers, broken, {}),
    (error) => error === failure,
  );
  post_worker_init(workers, fresh, {});
  await flush();
  assert.equal(workers.size, 2);
  release();
  await flush();
  assert.deepEqual([...workers], [fresh]);
  await discard_worker(workers, fresh);
  assert.equal(workers.size, 0);
});

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
  "a real Worker initialization exception is joined before releasing ownership",
  { timeout: 5000 },
  async (context) => {
    const native = new Worker("throw new Error('injected child initialization error');", {
      eval: true,
    });
    context.after(() => native.terminate());
    const failed = new Promise<Error>((resolve) => native.once("error", resolve));
    let exited = false;
    native.once("exit", () => {
      exited = true;
    });
    const worker: WorkerHandle = {
      post(message) {
        native.postMessage(message);
      },
      async terminate() {
        await native.terminate();
      },
    };
    const workers = new Set([worker]);
    assert.match((await failed).message, /injected child initialization error/);
    await discard_worker(workers, worker);
    assert.equal(exited, true);
    assert.equal(workers.size, 0);
  },
);

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
