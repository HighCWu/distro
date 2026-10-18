// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { deleteRootDisk, listRootDisks, persistentRootIdentity } from "./root-storage.js";
import { openRoot } from "./root.js";

function harness() {
  const files = new Map();
  const calls = [];
  const held = new Set();
  const filename = (name) => persistentRootIdentity(name).filename;
  const missing = () => new DOMException("disk missing", "NotFoundError");
  const directory = {
    async *values() {
      yield* files.values();
    },
    async getFileHandle(name, options) {
      calls.push(["get", name, options]);
      const handle = files.get(name);
      if (!handle) throw missing();
      if (handle.kind !== "file") throw new DOMException("not a file", "TypeMismatchError");
      return handle;
    },
    async removeEntry(name, options) {
      calls.push(["remove", name, options]);
      if (!files.delete(name)) throw missing();
    },
  };
  const dependencies = {
    storage: {
      async getDirectory() {
        calls.push(["directory"]);
        return directory;
      },
    },
    locks: {
      async request(name, options, body) {
        calls.push(["lock", name, options]);
        if (held.has(name)) return body(null);
        held.add(name);
        try {
          return await body({ name });
        } finally {
          held.delete(name);
          calls.push(["unlock", name]);
        }
      },
    },
  };
  function add(name, size = 512, extra = {}) {
    const handle = {
      name,
      kind: "file",
      async getFile() {
        return { size };
      },
      ...extra,
    };
    files.set(name, handle);
    return handle;
  }
  return {
    files,
    calls,
    held,
    directory,
    dependencies,
    add,
    disk: (name, size, extra) => add(filename(name), size, extra),
    list: () => listRootDisks(dependencies),
    delete: (name, confirmation = name) => deleteRootDisk({ name, confirmation }, dependencies),
  };
}

test("saved disk listing is sorted, scoped and includes incomplete files without reading content", async () => {
  const h = harness();
  h.disk("z", 0);
  h.disk("a", 512);
  for (const name of [
    "notes.txt",
    "linux-wasm64-UPPER.ext4",
    "linux-wasm64-.ext4",
    "linux-wasm64-a.ext4.backup",
    "linux-wasm64-a.ext4\n",
  ])
    h.add(name, 512, {
      async getFile() {
        assert.fail("unrelated entry metadata read");
      },
    });
  h.add("linux-wasm64-directory.ext4", 512, { kind: "directory" });
  assert.deepEqual(await h.list(), [
    { name: "a", size: 512 },
    { name: "z", size: 0 },
  ]);
  assert.deepEqual(h.calls, [["directory"]]);
});

test("listing tolerates entries removed concurrently but preserves real metadata failures", async () => {
  const h = harness();
  const gone = h.disk("gone", 512, {
    async getFile() {
      throw new DOMException("gone", "NotFoundError");
    },
  });
  assert.deepEqual(await h.list(), []);
  const failure = new Error("permission or I/O failure");
  gone.getFile = async () => {
    throw failure;
  };
  await assert.rejects(h.list(), (error) => error === failure);
  for (const size of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    gone.getFile = async () => ({ size });
    await assert.rejects(h.list(), /Invalid saved disk size/);
  }
});

test("deletion rejects invalid names and missing or mismatched confirmation before storage access", async () => {
  const h = harness();
  for (const name of [
    "",
    "../other",
    "a/b",
    "UPPER",
    "a".repeat(49),
    "a\n",
    "a\r",
    "a\u2028",
    null,
  ])
    await assert.rejects(h.delete(name), /Disk name/);
  for (const confirmation of [undefined, null, "", "other", " a", "a "])
    await assert.rejects(
      deleteRootDisk({ name: "a", confirmation }, h.dependencies),
      /confirmation/,
    );
  assert.deepEqual(h.calls, []);
});

test("disk management fails explicitly when browser storage or locks are unavailable", async () => {
  await assert.rejects(listRootDisks({ storage: null }), /OPFS is required/);
  for (const unavailable of [
    { storage: null, locks: {} },
    { storage: {}, locks: null },
  ])
    await assert.rejects(
      deleteRootDisk({ name: "a", confirmation: "a" }, unavailable),
      /OPFS and Web Locks/,
    );
});

test("confirmed deletion removes only the exact named file, including incomplete files", async () => {
  const h = harness();
  h.disk("a", 0);
  h.disk("other");
  h.add("unrelated");
  await h.delete("a");
  assert.deepEqual([...h.files.keys()], ["linux-wasm64-other.ext4", "unrelated"]);
  assert.deepEqual(
    h.calls.filter(([kind]) => kind === "get" || kind === "remove"),
    [
      ["get", "linux-wasm64-a.ext4", undefined],
      ["remove", "linux-wasm64-a.ext4", undefined],
    ],
  );
  assert.equal(h.held.size, 0);
  await assert.rejects(h.delete("a"), { name: "NotFoundError" });
  assert.equal(h.calls.filter(([kind]) => kind === "remove").length, 1);
});

test("missing, directory and removal failures are not success and always release the lease", async () => {
  const h = harness();
  h.disk("directory", 512, { kind: "directory" });
  await assert.rejects(h.delete("directory"), { name: "TypeMismatchError" });
  assert.equal(h.calls.filter(([kind]) => kind === "remove").length, 0);
  h.disk("a");
  const failure = new Error("remove failed");
  h.directory.removeEntry = async () => {
    throw failure;
  };
  await assert.rejects(h.delete("a"), (error) => error === failure);
  assert.equal(h.held.size, 0);
  assert.equal(h.files.has("linux-wasm64-a.ext4"), true);
});

test("deletion shares the actual openRoot lease until disk closure has settled", async () => {
  const h = harness();
  h.disk("active");
  const closed = Promise.withResolvers();
  const closeStarted = Promise.withResolvers();
  const device = { closed: closed.promise };
  const root = await openRoot(
    { mode: "open", name: "active" },
    {
      ...h.dependencies,
      Worker: class {},
      workerDevice() {},
      openWorker: async () => device,
      closeDevice: () => {
        closeStarted.resolve();
        return closed.promise;
      },
    },
  );
  await assert.rejects(h.delete("active"), /already open in another page/);
  const closing = root.close();
  await closeStarted.promise;
  await assert.rejects(h.delete("active"), /already open in another page/);
  assert.equal(h.files.has("linux-wasm64-active.ext4"), true);
  closed.resolve();
  await closing;
  await h.delete("active");
  assert.equal(h.files.size, 0);
});

test("a pending deletion retains its lease and excludes concurrent deletion", async () => {
  const h = harness();
  h.disk("a");
  const removeStarted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const remove = h.directory.removeEntry;
  h.directory.removeEntry = async (...args) => {
    removeStarted.resolve();
    await finish.promise;
    return remove(...args);
  };
  const deleting = h.delete("a");
  await removeStarted.promise;
  await assert.rejects(h.delete("a"), /already open in another page/);
  assert.equal(h.files.size, 1);
  finish.resolve();
  await deleting;
  assert.equal(h.held.size, 0);
  assert.equal(h.files.size, 0);
});
