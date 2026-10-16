// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { NR, SystemError } from "../src/abi.ts";
import type { AgentAbi, GuestSession } from "../src/conn.ts";
import { ChildProcess } from "../src/process.ts";
import { GuestFd } from "../src/syscalls.ts";

function fixture(signal?: AbortSignal, abi: AgentAbi = "wasm64", failClose = false) {
  let finishReap!: () => void;
  const reaped = new Promise<void>((resolve) => {
    finishReap = resolve;
  });
  let waitStatus = 0;
  let kills = 0;
  let releases = 0;
  const session = {
    abi,
    async exchange<T>(
      fn: (lane: {
        write(bytes: Uint8Array): Promise<void>;
        read(length: number): Promise<Uint8Array>;
      }) => Promise<T>,
    ): Promise<T> {
      let request!: Uint8Array;
      return fn({
        async write(bytes) {
          request = bytes.slice();
        },
        async read(length) {
          const result = new Uint8Array(length);
          if (request[0] === 3) {
            if (length === 12) await reaped;
            else {
              assert.equal(length, 4);
              new DataView(result.buffer).setUint32(0, waitStatus, true);
            }
          } else {
            assert.equal(request[0], 1);
            const nr = new DataView(request.buffer).getUint32(1, true);
            assert.ok([NR.kill, NR.read, NR.close].includes(nr));
            if (length === 12 && nr === NR.kill) kills++;
            if (length === 12 && nr === NR.close && failClose) {
              new DataView(result.buffer).setBigInt64(0, -1n, true);
              new DataView(result.buffer).setUint32(8, 5, true); // EIO
            }
            // read returns EOF, while close/kill succeed.
          }
          return result;
        },
      });
    },
  } as unknown as GuestSession;
  const child = new ChildProcess({
    session,
    pid: 123,
    stdin: new GuestFd(session, 10),
    stdout: new GuestFd(session, 11),
    stderr: new GuestFd(session, 12),
    signal,
    release() {
      releases++;
    },
  });
  return {
    child,
    get kills() {
      return kills;
    },
    get releases() {
      return releases;
    },
    finish(status = 9) {
      waitStatus = status;
      finishReap();
    },
  };
}

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`process close waits for reap and process-slot release, and is idempotent (${abi})`, async () => {
    const f = fixture(undefined, abi);
    let closed = false;
    const closing = f.child.close();
    assert.equal(f.child.close(), closing);
    void closing.then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      assert.equal(f.kills, 1);
      assert.equal(f.releases, 0);
      assert.equal(closed, false, "descriptor closure alone must not complete disposal");
    } finally {
      f.finish();
      await closing;
    }
    assert.equal(f.releases, 1);
    assert.deepEqual(await f.child.status, { success: false, code: 0, signal: "SIGKILL" });
  });

  test(`disposing an already reaped process does not signal its reusable PID (${abi})`, async () => {
    const f = fixture(undefined, abi);
    f.finish(0);
    await f.child.status;
    await f.child.close();
    assert.equal(f.kills, 0);
    assert.equal(f.releases, 1);
  });

  test(`public kill rejects confirmed reaped handles without signalling reusable PIDs (${abi})`, async () => {
    const f = fixture(undefined, abi);
    f.finish(0);
    await f.child.status;
    try {
      for (const signal of [undefined, "SIGTERM", "SIGKILL", "SIGUSR1"] as const) {
        await assert.rejects(
          f.child.kill(signal),
          (error) => error instanceof SystemError && error.code === "ESRCH",
        );
      }
      assert.equal(f.kills, 0);
    } finally {
      await f.child.close();
    }
  });

  test(`public kill still signals a live process and preserves its exit status (${abi})`, async () => {
    const f = fixture(undefined, abi);
    try {
      await f.child.kill("SIGTERM");
      assert.equal(f.kills, 1);
    } finally {
      f.finish(15);
      await f.child.close();
    }
    assert.deepEqual(await f.child.status, { success: false, code: 0, signal: "SIGTERM" });
  });

  test(`public kill also rejects an aborted handle after confirmed reap (${abi})`, async () => {
    const controller = new AbortController();
    const reason = new Error("caller abort");
    const f = fixture(controller.signal, abi);
    controller.abort(reason);
    f.finish();
    await assert.rejects(f.child.status, (error) => error === reason);
    await f.child.close();
    const previousKills = f.kills;
    await assert.rejects(
      f.child.kill("SIGUSR2"),
      (error) => error instanceof SystemError && error.code === "ESRCH",
    );
    assert.equal(f.kills, previousKills);
  });

  test(`aborted status retains its reason while close waits for release (${abi})`, async () => {
    const controller = new AbortController();
    const reason = new Error("caller abort");
    const f = fixture(controller.signal, abi);
    controller.abort(reason);
    let closed = false;
    const closing = f.child.close().then(() => {
      closed = true;
    });
    try {
      await setImmediate();
      assert.equal(closed, false);
    } finally {
      f.finish();
      await closing;
    }
    await assert.rejects(f.child.status, (error) => error === reason);
    assert.equal(f.releases, 1);
    assert.equal(f.kills, 1);
  });

  test(`descriptor close errors do not bypass process reaping (${abi})`, async () => {
    const f = fixture(undefined, abi, true);
    let settled = false;
    const closing = f.child.close();
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await setImmediate();
      assert.equal(settled, false);
    } finally {
      f.finish();
      await assert.rejects(closing, (error: { code?: string }) => error.code === "EIO");
    }
    assert.equal(f.releases, 1);
  });
}
