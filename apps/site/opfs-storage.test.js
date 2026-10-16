// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { installOpfsStorage } from "./opfs-storage.js";

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

test("successful installation retains ownership until close, including flush failure", () => {
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
