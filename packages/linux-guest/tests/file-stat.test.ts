// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { NR, stat_size, SystemError } from "../src/abi.ts";
import type { AgentAbi, GuestSession, Lane } from "../src/conn.ts";
import { FsFile } from "../src/file.ts";
import { CHUNK, GuestFd } from "../src/syscalls.ts";

function sessionFixture(errno = 0, abi: AgentAbi = "wasm32", closeErrno = 0) {
  const requests: Uint8Array[] = [];
  const stat = new Uint8Array(stat_size);
  const fields = new DataView(stat.buffer);
  fields.setBigUint64(8, 12345n, true);
  fields.setUint32(16, 0o100600, true);
  fields.setUint32(20, 0, true); // An open but unlinked file.
  fields.setBigInt64(48, 7n, true);
  const session = {
    abi,
    async exchange<T>(operation: (lane: Lane) => Promise<T>): Promise<T> {
      let nr = 0;
      let reads = 0;
      return operation({
        async write(bytes) {
          requests.push(bytes.slice());
          nr = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true);
        },
        async read(length) {
          if (reads++ === 0) {
            assert.equal(length, 12);
            const reply = new Uint8Array(12);
            const error = nr === NR.close ? closeErrno : errno;
            if (error) {
              const view = new DataView(reply.buffer);
              view.setBigInt64(0, -1n, true);
              view.setUint32(8, error, true);
            }
            return reply;
          }
          assert.equal(length, stat_size);
          return stat.slice();
        },
      });
    },
  } as GuestSession;
  return { session, requests };
}

test("open-file stat uses fstat64 with the descriptor and no pathname", async () => {
  const { session, requests } = sessionFixture();
  const file = new FsFile(new GuestFd(session, 42, "/no-longer-named"));
  try {
    const info = await file.stat();
    assert.equal(info.ino, 12345);
    assert.equal(info.nlink, 0);
    assert.equal(info.size, 7);
    assert.equal(info.isFile, true);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
    assert.equal(view.getUint8(0), 1);
    assert.equal(view.getUint32(1, true), 80);
    assert.deepEqual(Array.from(request.subarray(5, 11)), [0, 2, 0, 0, 0, 0]);
    assert.equal(view.getBigUint64(11, true), 42n);
    assert.equal(view.getBigUint64(19, true), BigInt(stat_size));
    assert.equal(request.length, 59, "there must be no /proc or other path blob");
  } finally {
    await file.close();
  }
});

test("open-file stat preserves the descriptor syscall error", async () => {
  const { session } = sessionFixture(9);
  const file = new FsFile(new GuestFd(session, 42));
  try {
    await assert.rejects(
      file.stat(),
      (error) => error instanceof SystemError && error.code === "EBADF",
    );
  } finally {
    await file.close();
  }
});

for (const abi of ["wasm32", "wasm64"] as const) {
  test(`${abi} direct writes reject non-byte buffers without closing the file`, async () => {
    const { session, requests } = sessionFixture(0, abi);
    const fd = new GuestFd(session, 42);
    const file = new FsFile(fd);
    try {
      for (const value of [
        "text",
        new ArrayBuffer(0),
        new Uint16Array(1),
        new DataView(new ArrayBuffer(0)),
      ])
        await assert.rejects(file.write(value as unknown as Uint8Array), TypeError);
      assert.equal(fd.closed, false);
      assert.equal(requests.length, 0);
    } finally {
      await file.close();
    }
  });

  for (const [kind, value] of [
    ["text", "not bytes"],
    ["buffer", new ArrayBuffer(0)],
    ["wide array", new Uint16Array(0)],
    ["view", new DataView(new ArrayBuffer(0))],
  ] as const) {
    test(`${abi} file writable rejects a ${kind} chunk and closes its handle`, async () => {
      const { session, requests } = sessionFixture(0, abi);
      const fd = new GuestFd(session, 42);
      const file = new FsFile(fd);
      const writer = file.writable.getWriter();
      try {
        await assert.rejects(writer.write(value as unknown as Uint8Array), TypeError);
        assert.equal(fd.closed, true);
        assert.deepEqual(
          requests.map((bytes) => new DataView(bytes.buffer).getUint32(1, true)),
          [NR.close],
        );
      } finally {
        writer.releaseLock();
        await file.close();
      }
    });
  }

  for (const shortFirst of [false, true]) {
    for (const following of ["write", "close"] as const) {
      test(`${abi} a stream chunk finishes before queued ${following} (${shortFirst})`, async () => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const written: Uint8Array[] = [];
        const requests: number[] = [];
        let first = true;
        const session = {
          abi,
          async exchange<T>(operation: (lane: Lane) => Promise<T>): Promise<T> {
            let blocked = false;
            let count = 0;
            return operation({
              async write(bytes) {
                const nr = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1, true);
                requests.push(nr);
                if (nr === NR.write) {
                  const data = bytes.subarray(59);
                  assert.ok(data.byteLength <= CHUNK);
                  blocked = first;
                  count = first && shortFirst ? 7 : data.byteLength;
                  written.push(data.slice(0, count));
                  first = false;
                  if (blocked) entered.resolve();
                }
              },
              async read(length) {
                assert.equal(length, 12);
                if (blocked) await release.promise;
                const reply = new Uint8Array(12);
                new DataView(reply.buffer).setBigInt64(0, BigInt(count), true);
                return reply;
              },
            });
          },
        } as GuestSession;
        const file = new FsFile(new GuestFd(session, 42));
        const writer = file.writable.getWriter();
        const payload = new Uint8Array(CHUNK * 2 + 13).fill(42);
        const writing = writer.write(payload);
        void writing.catch(() => {});
        try {
          await entered.promise;
          const later = following === "close" ? file.close() : file.write(Uint8Array.of(255));
          release.resolve();
          await writing;
          await later;
          await file.close();
          const result = new Uint8Array(
            written.reduce((length, bytes) => length + bytes.length, 0),
          );
          let offset = 0;
          for (const bytes of written) {
            result.set(bytes, offset);
            offset += bytes.byteLength;
          }
          const expected = new Uint8Array(payload.length + (following === "write" ? 1 : 0));
          expected.set(payload);
          if (following === "write") expected[payload.length] = 255;
          assert.deepEqual(result, expected);
          assert.equal(requests.at(-1), NR.close);
          assert.equal(requests.filter((nr) => nr === NR.close).length, 1);
        } finally {
          release.resolve();
          writer.releaseLock();
          await file.close().catch(() => {});
        }
      });
    }
  }

  for (const direction of ["read", "write"] as const) {
    for (const closeErrno of [0, 9]) {
      test(`${abi} file ${direction} stream closes on I/O error (${closeErrno})`, async () => {
        const { session, requests } = sessionFixture(5, abi, closeErrno);
        const fd = new GuestFd(session, 42);
        const file = new FsFile(fd);
        const stream = direction === "read" ? file.readable.getReader() : file.writable.getWriter();
        try {
          const result = "read" in stream ? stream.read() : stream.write(Uint8Array.of(1));
          await assert.rejects(result, (error) => {
            if (!closeErrno) return error instanceof SystemError && error.code === "EIO";
            assert.ok(error instanceof AggregateError);
            assert.equal(error.errors[0].code, "EIO");
            assert.equal(error.errors[1].code, "EBADF");
            assert.equal(error.cause, error.errors[0]);
            return true;
          });
          assert.equal(fd.closed, true);
          assert.deepEqual(
            requests.map((bytes) => new DataView(bytes.buffer).getUint32(1, true)),
            [direction === "read" ? NR.read : NR.write, NR.close],
          );
          await assert.rejects(file.write(Uint8Array.of(2)), TypeError);
          const before = requests.length;
          if (closeErrno) await assert.rejects(file.close(), { code: "EBADF" });
          else await file.close();
          assert.equal(requests.length, before);
        } finally {
          stream.releaseLock();
          await file.close().catch(() => {});
        }
      });
    }
  }

  test(`${abi} file writable closes on a zero-progress write`, async () => {
    const { session, requests } = sessionFixture(0, abi);
    const file = new FsFile(new GuestFd(session, 42));
    const writer = file.writable.getWriter();
    try {
      await assert.rejects(writer.write(Uint8Array.of(1)), { code: "EIO" });
      assert.deepEqual(
        requests.map((bytes) => new DataView(bytes.buffer).getUint32(1, true)),
        [NR.write, NR.close],
      );
    } finally {
      writer.releaseLock();
      await file.close();
    }
  });

  test(`${abi} direct file I/O errors retain caller-owned handles`, async () => {
    const { session, requests } = sessionFixture(5, abi);
    const fd = new GuestFd(session, 42);
    const file = new FsFile(fd);
    try {
      await assert.rejects(file.read(new Uint8Array(1)), { code: "EIO" });
      assert.equal(fd.closed, false);
      assert.equal(requests.length, 1);
    } finally {
      await file.close();
    }
  });
}
