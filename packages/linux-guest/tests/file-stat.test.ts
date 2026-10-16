// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { NR, stat_size, SystemError } from "../src/abi.ts";
import type { GuestSession, Lane } from "../src/conn.ts";
import { FsFile } from "../src/file.ts";
import { GuestFd } from "../src/syscalls.ts";

function sessionFixture(errno = 0) {
  const requests: Uint8Array[] = [];
  const stat = new Uint8Array(stat_size);
  const fields = new DataView(stat.buffer);
  fields.setBigUint64(8, 12345n, true);
  fields.setUint32(16, 0o100600, true);
  fields.setUint32(20, 0, true); // An open but unlinked file.
  fields.setBigInt64(48, 7n, true);
  const session = {
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
            if (nr !== NR.close && errno) {
              const view = new DataView(reply.buffer);
              view.setBigInt64(0, -1n, true);
              view.setUint32(8, errno, true);
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
