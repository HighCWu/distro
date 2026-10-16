// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { installOpfsStorage, openOpfsAccessHandle } from "./opfs-storage.js";

test("OPFS lock contention retries with bounded backoff and returns the acquired handle", async () => {
  const access = {};
  const waits = [];
  let attempts = 0;
  const result = await openOpfsAccessHandle(
    {
      async createSyncAccessHandle() {
        if (++attempts < 3) throw new DOMException("locked", "NoModificationAllowedError");
        return access;
      },
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  assert.equal(result, access);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("persistent OPFS lock contention stops after eight attempts", async () => {
  const failure = new DOMException("locked", "NoModificationAllowedError");
  const waits = [];
  let attempts = 0;
  await assert.rejects(
    openOpfsAccessHandle(
      {
        async createSyncAccessHandle() {
          attempts++;
          throw failure;
        },
      },
      async (ms) => {
        waits.push(ms);
      },
    ),
    (error) => error === failure,
  );
  assert.equal(attempts, 8);
  assert.deepEqual(waits, [10, 20, 40, 80, 160, 320, 640]);
});

test("OPFS permission and storage failures are not retried", async () => {
  for (const name of [
    "NotAllowedError",
    "NotFoundError",
    "QuotaExceededError",
    "InvalidStateError",
  ]) {
    const failure = new DOMException("unavailable", name);
    let attempts = 0;
    await assert.rejects(
      openOpfsAccessHandle(
        {
          async createSyncAccessHandle() {
            attempts++;
            throw failure;
          },
        },
        async () => assert.fail("must not delay unrelated failures"),
      ),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  }
});

test("partial OPFS reads and writes advance both the buffer and file offset", () => {
  const file = new Uint8Array(512);
  const calls = [];
  let storage;
  installOpfsStorage(
    {
      getSize: () => file.length,
      read(target, { at }) {
        const count = Math.min(2, target.length);
        calls.push(["read", at, target.length]);
        target.set(file.subarray(at, at + count));
        return count;
      },
      write(data, { at }) {
        const count = Math.min(2, data.length);
        calls.push(["write", at, data.length]);
        file.set(data.subarray(0, count), at);
        return count;
      },
    },
    undefined,
    (value) => {
      storage = value;
    },
  );
  const data = Uint8Array.of(11, 22, 33, 44, 55);
  assert.equal(storage.write(17, data), 5);
  const result = new Uint8Array(7).fill(99);
  assert.equal(storage.read(17, result.subarray(1, 6)), 5);
  assert.deepEqual(result, Uint8Array.of(99, ...data, 99));
  assert.deepEqual(calls, [
    ["write", 17, 5],
    ["write", 19, 3],
    ["write", 21, 1],
    ["read", 17, 5],
    ["read", 19, 3],
    ["read", 21, 1],
  ]);
  assert.equal(file[16], 0);
  assert.equal(file[22], 0);
});

for (const operation of ["read", "write"]) {
  test(`OPFS ${operation} stops on zero progress and propagates storage errors`, () => {
    let storage;
    let calls = 0;
    let fail = false;
    const failure = new Error("storage unavailable");
    installOpfsStorage(
      {
        getSize: () => 512,
        [operation]() {
          if (fail) throw failure;
          calls++;
          assert.ok(calls <= 2, "must not spin after zero progress");
          return calls === 1 ? 2 : 0;
        },
      },
      undefined,
      (value) => {
        storage = value;
      },
    );
    assert.equal(storage[operation](0, new Uint8Array(5)), 2);
    assert.equal(calls, 2);
    // Empty transfers must not touch the handle, even after a storage failure.
    fail = true;
    assert.equal(storage[operation](0, new Uint8Array(0)), 0);
    assert.throws(
      () => storage[operation](0, new Uint8Array(5)),
      (error) => error === failure,
    );
  });
}

test("invalid capacity releases the handle without truncating data", () => {
  for (const capacity of [-512, 1, NaN, Infinity, 2 ** 53]) {
    let closed = 0;
    installFailure(capacity);
    function installFailure(value) {
      assert.throws(
        () =>
          installOpfsStorage(
            {
              truncate() {
                assert.fail("must validate before truncation");
              },
              close() {
                closed++;
              },
            },
            value,
            () => assert.fail("must not install"),
          ),
        RangeError,
      );
    }
    assert.equal(closed, 1);
  }
});

for (const stage of ["truncate", "getSize", "install"]) {
  test(`OPFS ${stage} failure closes the handle and preserves the error`, () => {
    const failure = new Error(stage);
    let closed = 0;
    const access = {
      truncate() {
        if (stage === "truncate") throw failure;
      },
      getSize() {
        if (stage === "getSize") throw failure;
        return 512;
      },
      close() {
        closed++;
        throw new Error("close failed");
      },
    };
    assert.throws(
      () =>
        installOpfsStorage(access, 512, () => {
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(closed, 1);
  });
}

test("close reports release failure after a successful flush", () => {
  const calls = [];
  const failure = new Error("close failed");
  let storage;
  installOpfsStorage(
    {
      getSize: () => 512,
      flush() {
        calls.push("flush");
      },
      close() {
        calls.push("close");
        throw failure;
      },
    },
    undefined,
    (value) => {
      storage = value;
    },
  );
  assert.throws(
    () => storage.close(),
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["flush", "close"]);
});

for (const closeFails of [false, true])
  test(`close preserves flush failure when closeFails=${closeFails}`, () => {
    let closed = 0;
    let storage;
    const failure = new Error("flush failed");
    installOpfsStorage(
      {
        getSize() {
          return 1024;
        },
        flush() {
          throw failure;
        },
        close() {
          closed++;
          if (closeFails) throw new Error("close failed too");
        },
      },
      undefined,
      (value) => {
        storage = value;
      },
    );
    assert.equal(storage.capacity, 1024);
    assert.equal(closed, 0);
    assert.throws(
      () => storage.close(),
      (error) => error === failure,
    );
    assert.equal(closed, 1);
  });
