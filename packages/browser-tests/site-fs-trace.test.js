// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { installSiteFsTrace } from "./site-fs-trace.js";

function fixture(method) {
  class FileSystemFileHandle {
    name = "probe";
  }
  FileSystemFileHandle.prototype.createWritable = method;
  const scope = { FileSystemFileHandle, performance };
  installSiteFsTrace(scope);
  return { handle: new FileSystemFileHandle(), snapshot: scope.__siteFsTrace };
}

test("trace preserves receiver, arguments, promise and result identity", async () => {
  const result = {};
  const promise = Promise.resolve(result);
  const options = { keepExistingData: true };
  const { handle, snapshot } = fixture(function (value) {
    assert.equal(this, handle);
    assert.equal(value, options);
    return promise;
  });
  assert.equal(handle.createWritable(options), promise);
  assert.equal(snapshot().pending.length, 1);
  assert.equal(await promise, result);
  assert.equal(snapshot().pending.length, 0);
  assert.equal(snapshot().recent[0].operation, "FileSystemFileHandle.createWritable");
  assert.ok(snapshot().recent[0].elapsedMs >= 0);
});

test("trace preserves rejection and synchronous exception identity without messages", async () => {
  const error = new Error("private file contents");
  for (const synchronous of [false, true]) {
    const promise = Promise.reject(error);
    // The synchronous variant does not return the promise.
    promise.catch(() => {});
    const { handle, snapshot } = fixture(() => {
      if (synchronous) throw error;
      return promise;
    });
    if (synchronous)
      assert.throws(
        () => handle.createWritable(),
        (value) => value === error,
      );
    else await assert.rejects(handle.createWritable(), (value) => value === error);
    assert.equal(snapshot().pending.length, 0);
    assert.equal(snapshot().recent[0].error, "Error");
    assert.ok(!JSON.stringify(snapshot()).includes(error.message));
  }
});

test("trace bounds both completed history and permanently pending operations", async () => {
  let promise = Promise.resolve();
  const { handle, snapshot } = fixture(() => promise);
  for (let i = 0; i < 100; i++) await handle.createWritable();
  assert.equal(snapshot().recent.length, 64);
  promise = new Promise(() => {});
  for (let i = 0; i < 100; i++) handle.createWritable();
  assert.equal(snapshot().pending.length, 64);
  assert.equal(snapshot().omitted, 36);
});

test("trace identifies writes by their opening file without retaining payloads", async () => {
  class FileSystemWritableFileStream {
    write(value) {
      assert.equal(value, payload);
      return Promise.resolve();
    }
  }
  class FileSystemFileHandle {
    name = "boot-probe";
    createWritable() {
      return Promise.resolve(new FileSystemWritableFileStream());
    }
  }
  const payload = new Uint8Array([0, 255, 42]);
  const scope = { FileSystemFileHandle, FileSystemWritableFileStream, performance };
  installSiteFsTrace(scope);
  const stream = await new FileSystemFileHandle().createWritable();
  await stream.write(payload);
  const trace = scope.__siteFsTrace();
  assert.equal(trace.recent[1].name, "boot-probe");
  assert.equal(trace.recent[1].operation, "FileSystemWritableFileStream.write");
  assert.ok(!JSON.stringify(trace).includes("255"));
});

test("trace accepts absent File System API surfaces", () => {
  const scope = { performance };
  installSiteFsTrace(scope);
  assert.deepEqual(scope.__siteFsTrace(), { pending: [], recent: [], omitted: 0 });
});
