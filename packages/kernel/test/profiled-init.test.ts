// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Worker, MessageChannel } from "node:worker_threads";
import { profiled_init_queue } from "../src/profiled-init.ts";

test("profiled init waits for module-ready and measures queue/send separately", () => {
  let clock = 0,
    closed = 0;
  const sent: unknown[] = [],
    metrics: number[][] = [];
  const queue = profiled_init_queue(
    (message) => {
      sent.push(message);
      clock += 2;
    },
    (q, p) => metrics.push([q, p]),
    (e) => {
      throw e;
    },
    () => clock,
  );
  queue.post("init", [
    {
      close() {
        closed++;
      },
    } as unknown as Transferable,
  ]);
  assert.deepEqual(sent, []);
  clock = 25;
  queue.ready();
  assert.deepEqual(sent, ["init"]);
  assert.deepEqual(metrics, [[25e6, 2e6]]);
  queue.stop();
  assert.equal(closed, 0, "a successfully transferred port is no longer owned by the queue");
});

test("stopping a pending init closes owned ports once and rejects late publication", () => {
  let closed = 0,
    sent = 0;
  const queue = profiled_init_queue(
    () => {
      sent++;
    },
    () => {},
    () => {},
  );
  queue.post("init", [
    {
      close() {
        closed++;
      },
    } as unknown as Transferable,
  ]);
  queue.stop();
  queue.stop();
  queue.ready();
  assert.equal(closed, 1);
  assert.equal(sent, 0);
  assert.throws(() => queue.post("late"), /stopped/);
});

test("deferred transfer failure closes owned ports and uses the asynchronous failure path", () => {
  let closed = 0;
  const errors: Error[] = [];
  const failure = Error("clone failed");
  const queue = profiled_init_queue(
    () => {
      throw failure;
    },
    () => assert.fail("success metric"),
    (e) => errors.push(e),
  );
  queue.post("init", [
    {
      close() {
        closed++;
      },
    } as unknown as Transferable,
  ]);
  queue.ready();
  queue.ready();
  assert.equal(closed, 1);
  assert.deepEqual(errors, [failure]);
  assert.throws(() => queue.post("late"), /stopped/);
});

test("ready-first transfer failures remain synchronous; duplicate readiness never retransmits", () => {
  let closed = 0,
    sent = 0;
  const errors: Error[] = [];
  const queue = profiled_init_queue(
    () => {
      sent++;
      throw Error("transfer");
    },
    () => {},
    (e) => errors.push(e),
  );
  queue.ready();
  assert.throws(
    () =>
      queue.post("init", [
        {
          close() {
            closed++;
          },
        } as unknown as Transferable,
      ]),
    /transfer/,
  );
  queue.ready();
  assert.equal(closed, 1);
  assert.equal(sent, 1);
  assert.equal(errors.length, 0);
  const duplicate = profiled_init_queue(
    () => {
      sent++;
    },
    () => {},
    (e) => errors.push(e),
  );
  duplicate.post("once");
  duplicate.ready();
  duplicate.ready();
  assert.equal(sent, 2);
  assert.equal(errors.length, 1);
  assert.throws(() => duplicate.post("late"), /stopped/);
  const pending = profiled_init_queue(
    () => {},
    () => {},
    () => {},
  );
  pending.post("first");
  assert.throws(() => pending.post("second"), /pending init/);
  pending.stop();
});

test("real diagnostic bootstrap loads the module before releasing a transferred init port", async () => {
  const fakeModule = `const {parentPort}=Reflect.get(globalThis,"process").getBuiltinModule("node:worker_threads");
    parentPort.on("message",m=>{m.port.postMessage("port-owned-by-worker");parentPort.postMessage({type:"echo",value:m.type});});
    await new Promise(r=>setTimeout(r,10));`;
  const target = `data:text/javascript;base64,${Buffer.from(fakeModule).toString("base64")}`;
  const bootstrap = readFileSync(
    new URL("../src/fork-profile-worker.ts", import.meta.url),
    "utf8",
  ).replace('"./worker.js"', JSON.stringify(target));
  const worker = new Worker(
    new URL(`data:text/javascript;base64,${Buffer.from(bootstrap).toString("base64")}`),
  );
  const channel = new MessageChannel();
  const events: string[] = [];
  let finish!: () => void, reject!: (error: Error) => void;
  const result = new Promise<void>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  const queue = profiled_init_queue(
    (m, t) => worker.postMessage(m, t as never),
    () => events.push("posted"),
    reject,
  );
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, fail) => {
    timeout = setTimeout(() => fail(Error("bootstrap timed out")), 3000);
  });
  worker.on("error", reject);
  worker.on("message", (m) => {
    if (m.type === "fork_profile_module_ready") {
      assert.ok(Number.isSafeInteger(m.module_ns) && m.module_ns >= 0);
      events.push("module-ready");
      queue.ready();
    } else {
      assert.equal(m.type, "echo");
      assert.equal(m.value, "init");
      events.push("echo");
      finish();
    }
  });
  const portResult = new Promise<string>((resolve) => channel.port2.once("message", resolve));
  try {
    queue.post({ type: "init", port: channel.port1 }, [channel.port1 as unknown as Transferable]);
    const [, portValue] = await Promise.race([Promise.all([result, portResult]), deadline]);
    assert.equal(portValue, "port-owned-by-worker");
    assert.deepEqual(events, ["module-ready", "posted", "echo"]);
  } finally {
    clearTimeout(timeout!);
    queue.stop();
    channel.port2.close();
    await worker.terminate();
  }
});
