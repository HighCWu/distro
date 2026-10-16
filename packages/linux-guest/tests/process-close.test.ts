// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { NR, SystemError } from "../src/abi.ts";
import type { AgentAbi, GuestSession } from "../src/conn.ts";
import { ChildProcess } from "../src/process.ts";
import { GuestFd } from "../src/syscalls.ts";

function fixture(
  signal?: AbortSignal,
  abi: AgentAbi = "wasm64",
  failClose = false,
  bufferedOutput = false,
  writeErrno = 0,
  stdinMode?: "buffered" | "streaming",
  writeGate?: Promise<void>,
) {
  let finishReap!: () => void;
  const reaped = new Promise<void>((resolve) => {
    finishReap = resolve;
  });
  let waitStatus = 0;
  let kills = 0;
  let releases = 0;
  let reads = 0;
  let writes = 0;
  const writtenData: Uint8Array[] = [];
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
          if (request[0] === 1 && new DataView(request.buffer).getUint32(1, true) === NR.read)
            reads++;
          if (request[0] === 1 && new DataView(request.buffer).getUint32(1, true) === NR.write) {
            writes++;
            writtenData.push(request.slice(59));
          }
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
            assert.ok([NR.kill, NR.read, NR.close, NR.write].includes(nr));
            if (nr === NR.write) {
              await writeGate;
              assert.equal(length, 12);
              const view = new DataView(result.buffer);
              view.setBigInt64(0, writeErrno ? -1n : BigInt(request.byteLength - 59), true);
              view.setUint32(8, writeErrno, true);
            }
            if (nr === NR.read && bufferedOutput) {
              if (length === 12) new DataView(result.buffer).setBigInt64(0, 1n, true);
              else {
                assert.equal(length, 1);
                result[0] = 65;
              }
            }
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
    stdinMode,
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
    get reads() {
      return reads;
    },
    get writes() {
      return writes;
    },
    writtenData,
    finish(status = 9) {
      waitStatus = status;
      finishReap();
    },
  };
}

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`streaming pipeTo does not drain its producer while a native write is blocked (${abi})`, async () => {
    let drain!: () => void;
    const gate = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const f = fixture(undefined, abi, false, false, 0, "streaming", gate);
    let produced = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (produced === 3) controller.close();
          else controller.enqueue(Uint8Array.of(++produced));
        },
      },
      { highWaterMark: 0 },
    );
    const piping = source.pipeTo(f.child.stdin);
    try {
      await setImmediate();
      assert.equal(produced, 1);
      assert.equal(f.writes, 1);
      drain();
      await piping;
      assert.equal(produced, 3);
      assert.deepEqual(
        f.writtenData,
        [1, 2, 3].map((value) => Uint8Array.of(value)),
      );
    } finally {
      drain();
      f.finish();
      await f.child.close();
      await piping.catch(() => {});
    }
  });

  for (const stdinMode of [undefined, "buffered", "streaming"] as const) {
    test(`stdin ${stdinMode ?? "default"} applies its documented backpressure (${abi})`, async () => {
      let drain!: () => void;
      const gate = new Promise<void>((resolve) => {
        drain = resolve;
      });
      const f = fixture(undefined, abi, false, false, 0, stdinMode, gate);
      const writer = f.child.stdin.getWriter();
      const data = Uint8Array.from({ length: 32768 + 17 }, (_, i) => i & 255);
      const snapshot = data.slice();
      let settled = false;
      const writing = writer.write(data).then(() => {
        settled = true;
      });
      try {
        await setImmediate();
        assert.equal(f.writes, 1);
        assert.equal(settled, stdinMode !== "streaming");
        assert.equal(f.reads, 2); // output pulls can progress while stdin waits
        data.fill(0);
        drain();
        await writing;
        await writer.close();
        assert.deepEqual(f.writtenData, [snapshot.subarray(0, 32768), snapshot.subarray(32768)]);
        f.finish(0);
        assert.equal((await f.child.status).success, true);
      } finally {
        drain();
        f.finish();
        await f.child.close();
        writer.releaseLock();
      }
    });
  }

  test(`streaming stdin surfaces a pump error on the same write (${abi})`, async () => {
    const f = fixture(undefined, abi, false, false, 5, "streaming");
    const writer = f.child.stdin.getWriter();
    void writer.closed.catch(() => {});
    try {
      await assert.rejects(writer.write(Uint8Array.of(1)), { code: "EIO" });
      await assert.rejects(writer.closed, { code: "EIO" });
      assert.equal(f.writes, 1);
    } finally {
      f.finish();
      await f.child.close();
      writer.releaseLock();
    }
  });

  test(`streaming stdin disposal settles its in-flight write before releasing fds (${abi})`, async () => {
    let drain!: () => void;
    const gate = new Promise<void>((resolve) => {
      drain = resolve;
    });
    const f = fixture(undefined, abi, false, false, 0, "streaming", gate);
    const writer = f.child.stdin.getWriter();
    void writer.closed.catch(() => {});
    const writing = writer.write(Uint8Array.of(1));
    void writing.catch(() => {});
    try {
      await setImmediate();
      let closed = false;
      const closing = f.child.close().then(() => {
        closed = true;
      });
      await setImmediate();
      assert.equal(closed, false);
      drain();
      await assert.rejects(writing, { code: "EPIPE" });
      f.finish();
      await closing;
      await assert.rejects(writer.closed, { code: "EPIPE" });
    } finally {
      drain();
      f.finish();
      await f.child.close();
      writer.releaseLock();
    }
  });

  test(`process disposal preserves an already observed stdin pump failure (${abi})`, async () => {
    const f = fixture(undefined, abi, false, false, 5);
    const writer = f.child.stdin.getWriter();
    void writer.closed.catch(() => {});
    try {
      await writer.write(Uint8Array.of(1));
      await setImmediate();
      f.finish();
      await f.child.close();
      await assert.rejects(writer.closed, { code: "EIO" });
      await assert.rejects(writer.write(Uint8Array.of(2)), { code: "EIO" });
      assert.equal(f.writes, 1);
    } finally {
      f.finish();
      await f.child.close();
      writer.releaseLock();
    }
  });

  test(`process disposal rejects stdin immediately while reap is pending (${abi})`, async () => {
    const f = fixture(undefined, abi);
    const writer = f.child.stdin.getWriter();
    void writer.closed.catch(() => {});
    const closing = f.child.close();
    try {
      await assert.rejects(writer.write(Uint8Array.of(1)), { code: "EPIPE" });
      await assert.rejects(writer.closed, { code: "EPIPE" });
      assert.equal(f.releases, 0);
      assert.equal(f.writes, 0);
    } finally {
      f.finish();
      await closing;
      writer.releaseLock();
    }
  });

  test(`new stdin writers cannot silently discard bytes after process disposal (${abi})`, async () => {
    const f = fixture(undefined, abi);
    f.finish();
    await f.child.close();
    const writer = f.child.stdin.getWriter();
    try {
      await assert.rejects(writer.write(new Uint8Array()), { code: "EPIPE" });
      await assert.rejects(writer.closed, { code: "EPIPE" });
      await assert.rejects(writer.close(), TypeError); // Web Streams terminal-state rule
      assert.equal(f.writes, 0);
    } finally {
      writer.releaseLock();
    }
  });

  test(`aborting a process rejects stdin without replacing the status reason (${abi})`, async () => {
    const controller = new AbortController();
    const f = fixture(controller.signal, abi);
    const writer = f.child.stdin.getWriter();
    void writer.closed.catch(() => {});
    const reason = new Error("application cancelled");
    controller.abort(reason);
    try {
      await assert.rejects(writer.write(Uint8Array.of(1)), { code: "EPIPE" });
      f.finish();
      await assert.rejects(f.child.status, (error) => error === reason);
      assert.equal(f.writes, 0);
    } finally {
      f.finish();
      await f.child.close();
      writer.releaseLock();
    }
  });

  test(`normal stdin EOF remains successful after process disposal (${abi})`, async () => {
    const f = fixture(undefined, abi);
    const writer = f.child.stdin.getWriter();
    try {
      await writer.write(Uint8Array.of(0, 255, 65));
      await writer.close();
      f.finish(0);
      await f.child.close();
      await writer.closed;
      assert.equal(f.writes, 1);
      assert.equal((await f.child.status).success, true);
    } finally {
      f.finish();
      await f.child.close();
      writer.releaseLock();
    }
  });

  test(`closed process output cannot issue reads through a reused descriptor (${abi})`, async () => {
    const f = fixture(undefined, abi, false, true);
    await setImmediate(); // each output stream has prefetched one chunk
    assert.equal(f.reads, 2);
    const closing = f.child.close();
    f.finish();
    await closing;
    for (const stream of [f.child.stdout, f.child.stderr]) {
      const reader = stream.getReader();
      try {
        assert.deepEqual((await reader.read()).value, Uint8Array.of(65));
        await assert.rejects(reader.read(), { code: "EBADF" });
      } finally {
        reader.releaseLock();
      }
    }
    assert.equal(f.reads, 2);
  });

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
