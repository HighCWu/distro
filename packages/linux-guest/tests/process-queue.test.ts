// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { create_guest_client } from "../src/client.ts";
import { GuestSession, type AgentAbi } from "../src/conn.ts";
import type { ChildProcess } from "../src/process.ts";
import type { VsockDevice } from "@lowland/kernel";

function fixture(abi: AgentAbi) {
  let spawns = 0;
  const commands: string[] = [];
  let finish!: () => void;
  const reaped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const session = {
    abi,
    async exchange<T>(
      fn: (lane: {
        write(bytes: Uint8Array): Promise<void>;
        read(length: number): Promise<Uint8Array>;
      }) => Promise<T>,
    ): Promise<T> {
      let request!: Uint8Array;
      let pid = 0;
      return fn({
        async write(bytes) {
          request = bytes.slice();
          if (request[0] === 2) {
            pid = ++spawns;
            const length = new DataView(request.buffer).getUint32(9, true);
            commands.push(new TextDecoder().decode(request.subarray(13, 13 + length)));
          }
        },
        async read(length) {
          const result = new Uint8Array(length);
          if (request[0] === 3) {
            await reaped;
          } else if (request[0] === 2 && length === 16) {
            const view = new DataView(result.buffer);
            [pid, pid * 3, pid * 3 + 1, pid * 3 + 2].forEach((value, i) =>
              view.setUint32(i * 4, value, true),
            );
          }
          return result;
        },
      });
    },
  } as unknown as GuestSession;
  return {
    session,
    finish,
    commands,
    get spawns() {
      return spawns;
    },
  };
}

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`exec rechecks abort after a slot grant and returns the unused slot (${abi})`, async (t) => {
    const f = fixture(abi);
    t.mock.method(GuestSession, "connect", async () => f.session);
    const client = create_guest_client({} as VsockDevice, { abi });
    await client.ping();
    const controller = new AbortController();
    const reason = new Error("cancel between grant and spawn");
    const pending = client.exec(["must-not-spawn"], { signal: controller.signal });
    queueMicrotask(() => controller.abort(reason));
    try {
      await assert.rejects(pending, (error) => error === reason);
      assert.equal(f.spawns, 0);
    } finally {
      f.finish();
      const unexpected = await pending.catch(() => undefined);
      await unexpected?.close();
    }
    const next = await client.exec(["next"]);
    await next.close();
    assert.equal(f.spawns, 1);
  });

  test(`cancelling a middle queued exec preserves FIFO admission and removes its listener (${abi})`, async (t) => {
    const f = fixture(abi);
    t.mock.method(GuestSession, "connect", async () => f.session);
    const client = create_guest_client({} as VsockDevice, { abi });
    const children: ChildProcess[] = [];
    const waiting: Promise<ChildProcess | undefined>[] = [];
    const controller = new AbortController();
    const removed = t.mock.method(controller.signal, "removeEventListener");
    const survivor = new AbortController();
    const grantedAdded = t.mock.method(survivor.signal, "addEventListener");
    const grantedRemoved = t.mock.method(survivor.signal, "removeEventListener");
    const reason = new Error("cancel middle waiter");
    try {
      for (let i = 0; i < 8; i++) children.push(await client.exec(["hold"]));
      waiting.push(client.exec(["first"], { signal: survivor.signal }));
      waiting.push(
        client.exec(["cancelled"], { signal: controller.signal }).catch((error) => {
          assert.equal(error, reason);
          return undefined;
        }),
      );
      waiting.push(client.exec(["last"]));
      await setImmediate();
      controller.abort(reason);
      await setImmediate();
      assert.equal(removed.mock.callCount(), 1);
    } finally {
      f.finish();
      for (const pending of waiting) {
        const child = await pending;
        if (child) children.push(child);
      }
      await Promise.all(children.map((child) => child.close()));
    }
    assert.deepEqual(f.commands, [...Array(8).fill("hold"), "first", "last"]);
    // Identify admission's listener separately from the child's listener,
    // which disposal/reap may remove idempotently more than once.
    assert.equal(grantedAdded.mock.callCount(), 2);
    const listener = grantedAdded.mock.calls[0]!.arguments[1];
    assert.equal(
      grantedRemoved.mock.calls.filter((call) => call.arguments[1] === listener).length,
      1,
    );
  });

  test(`queued exec aborts without waiting for or spawning behind running children (${abi})`, async (t) => {
    const f = fixture(abi);
    t.mock.method(GuestSession, "connect", async () => f.session);
    const client = create_guest_client({} as VsockDevice, { abi });
    const children: ChildProcess[] = [];
    const controller = new AbortController();
    const reason = new Error("cancel queued command");
    let settled = false;
    let error: unknown;
    let queued: Promise<void> | undefined;
    try {
      for (let i = 0; i < 8; i++) children.push(await client.exec(["hold"]));
      queued = client.exec(["must-not-spawn"], { signal: controller.signal }).then(
        (child) => {
          children.push(child);
          settled = true;
        },
        (failure) => {
          error = failure;
          settled = true;
        },
      );
      await setImmediate();
      assert.equal(f.spawns, 8);
      assert.equal(settled, false);
      controller.abort(reason);
      await setImmediate();
      assert.equal(settled, true, "abort must settle while all original processes remain unreaped");
      assert.equal(error, reason);
      assert.equal(f.spawns, 8, "a queued abort must not create a process");
    } finally {
      f.finish();
      await queued;
      await Promise.all(children.map((child) => child.close()));
    }
    const next = await client.exec(["next"]);
    await next.close();
    assert.equal(f.spawns, 9, "cancelled waiters must not retain capacity or spawn later");
  });
}
