// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { openRoot } from "./root.js";

function harness({
  exists = false,
  writeError,
  startupError,
  closeError,
  deferClose = false,
  available = true,
} = {}) {
  const calls = [];
  const closed = Promise.withResolvers();
  let held = false;
  const device = {
    closed: closed.promise,
    close() {
      calls.push(["close"]);
      if (closeError) closed.reject(closeError);
      else if (!deferClose) closed.resolve();
      return closed.promise;
    },
  };
  void closed.promise.catch(() => {});
  const handle = {
    async getFile() {
      return { size: 512 };
    },
    async createWritable() {
      calls.push(["writable"]);
      return new WritableStream({
        async write(data) {
          calls.push(["write", data.byteLength]);
          if (writeError) throw writeError;
        },
        async close() {
          calls.push(["commit"]);
        },
        async abort() {
          calls.push(["abort"]);
          throw new Error("secondary abort");
        },
      });
    },
  };
  const dependencies = {
    async loadImage(path, { stream = false } = {}) {
      calls.push(["image", path]);
      if (stream)
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(512));
            controller.close();
          },
        });
      return new Uint8Array(512);
    },
    blockDevice(storage) {
      calls.push(["memory"]);
      return storage;
    },
    closeDevice: (device) => device.close(),
    workerDevice() {},
    Worker: class {
      constructor(url, options) {
        calls.push(["worker", url, options.type]);
      }
    },
    storage: {
      async getDirectory() {
        calls.push(["directory"]);
        return {
          async getFileHandle(name, options) {
            calls.push(["file", name, options]);
            if (!exists && !options?.create) throw new DOMException("missing", "NotFoundError");
            exists = true;
            return handle;
          },
        };
      },
    },
    locks: {
      async request(name, options, body) {
        calls.push(["lock", name, options.ifAvailable]);
        if (!available || held) return body(null);
        held = true;
        try {
          return await body({ name });
        } finally {
          held = false;
          calls.push(["unlock"]);
        }
      },
    },
    async openWorker(worker, config, connect) {
      calls.push(["connect", config, connect]);
      if (startupError) throw startupError;
      return device;
    },
  };
  return {
    calls,
    handle,
    dependencies,
    closed,
    held: () => held,
    open: (mode, name = "workspace") => openRoot({ mode, name }, dependencies),
  };
}

test("temporary root remains memory-only and never opens browser storage", async () => {
  const h = harness();
  const root = await h.open("temporary");
  root.device.write(2, Uint8Array.of(3, 4));
  const data = new Uint8Array(2);
  assert.equal(root.device.read(2, data), 2);
  assert.deepEqual(data, Uint8Array.of(3, 4));
  await root.close();
  assert.deepEqual(h.calls, [["image", "/root.ext4"], ["memory"]]);
});

test("new disk commits the template once and attaches without capacity or truncation", async () => {
  const h = harness();
  const root = await h.open("create");
  assert.equal(h.calls.filter(([kind]) => kind === "image").length, 1);
  assert.equal(h.calls.filter(([kind]) => kind === "write").length, 1);
  assert.deepEqual(h.calls.find(([kind]) => kind === "connect")[1], { handle: h.handle });
  assert.equal(h.held(), true);
  await root.close();
  await root.close();
  assert.equal(h.calls.filter(([kind]) => kind === "close").length, 1);
  assert.equal(h.held(), false);
});

test("reopening never fetches, creates, writes or resizes the root template", async () => {
  const h = harness({ exists: true });
  const root = await h.open("open");
  assert.deepEqual(
    h.calls.filter(([kind]) => ["image", "write", "writable"].includes(kind)),
    [],
  );
  assert.deepEqual(
    h.calls.filter(([kind]) => kind === "file"),
    [["file", "linux-wasm64-workspace.ext4", undefined]],
  );
  assert.deepEqual(h.calls.find(([kind]) => kind === "connect")[1], { handle: h.handle });
  await root.close();
});

test("existing creation and missing reopen fail without replacement or fallback", async () => {
  for (const [exists, mode, pattern] of [
    [true, "create", /already exists/],
    [false, "open", /missing/],
  ]) {
    const h = harness({ exists });
    await assert.rejects(h.open(mode), pattern);
    assert.equal(h.held(), false);
    assert.ok(!h.calls.some(([kind]) => ["image", "write", "connect"].includes(kind)));
  }
});

test("invalid names, modes and unavailable features are rejected before storage access", async () => {
  for (const name of ["", "../disk", "a/b", "UPPER", "a".repeat(49), null]) {
    const h = harness();
    await assert.rejects(h.open("open", name), /Disk name/);
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  await assert.rejects(h.open("guess"), /storage mode/);
  h.dependencies.locks = null;
  await assert.rejects(h.open("open"), /no temporary fallback/);
  assert.deepEqual(h.calls, []);
});

test("contention is refused and ownership lasts until device closure settles", async () => {
  const h = harness({ exists: true, deferClose: true });
  const root = await h.open("open");
  await assert.rejects(h.open("create"), /another page/);
  const stopping = root.close();
  assert.equal(h.held(), true);
  h.closed.resolve();
  await stopping;
  assert.equal(h.held(), false);
});

test("template and worker startup failures preserve their error and release the lease", async () => {
  for (const kind of ["writeError", "startupError"]) {
    const reason = new Error(kind);
    const h = harness({ [kind]: reason });
    await assert.rejects(h.open("create"), (error) => error === reason);
    assert.equal(h.held(), false);
    if (kind === "writeError") {
      assert.ok(!h.calls.some(([name]) => name === "commit"));
      assert.ok(!h.calls.some(([name]) => name === "worker"));
    }
  }
});

test("creation streams exact chunks with backpressure before attaching the worker", async () => {
  const h = harness();
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let pulled = 0;
  const written = [];
  h.dependencies.loadImage = async (path, options) => {
    assert.equal(path, "/root.ext4");
    assert.deepEqual(options, { stream: true });
    return new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(64).fill(pulled++));
        if (pulled === 8) controller.close();
      },
    });
  };
  h.handle.createWritable = async () =>
    new WritableStream({
      async write(chunk) {
        written.push(chunk.slice());
        entered.resolve();
        await resume.promise;
      },
      close() {
        h.calls.push(["commit"]);
      },
    });
  const opening = h.open("create");
  try {
    await entered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(pulled <= 2, `download pulled ${pulled} chunks while storage blocked`);
    assert.equal(h.held(), true);
    assert.ok(!h.calls.some(([name]) => name === "worker" || name === "commit"));
  } finally {
    resume.resolve();
  }
  const root = await opening;
  assert.equal(written.length, 8);
  for (let i = 0; i < 8; i++) assert.deepEqual(written[i], new Uint8Array(64).fill(i));
  assert.ok(
    h.calls.findIndex(([name]) => name === "commit") <
      h.calls.findIndex(([name]) => name === "worker"),
  );
  await root.close();
});

test("stream failures preserve the primary error and release download, writer and lease", async () => {
  for (const stage of ["download", "create", "writable", "write", "commit"]) {
    const h = harness();
    const reason = new Error(`failed ${stage}`);
    let cancelled = 0;
    let aborted = 0;
    if (stage === "create") {
      h.dependencies.storage.getDirectory = async () => ({
        async getFileHandle(_name, options) {
          if (options?.create) throw reason;
          throw new DOMException("missing", "NotFoundError");
        },
      });
    }
    h.dependencies.loadImage = async () =>
      new ReadableStream(
        {
          pull(controller) {
            if (stage === "download") controller.error(reason);
            else controller.enqueue(new Uint8Array(512));
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      );
    if (stage === "commit") {
      h.dependencies.loadImage = async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(512));
            controller.close();
          },
        });
    }
    h.handle.createWritable = async () => {
      if (stage === "writable") throw reason;
      return new WritableStream({
        write() {
          if (stage === "write") throw reason;
        },
        close() {
          throw reason;
        },
        abort() {
          aborted++;
          throw new Error("secondary abort failure");
        },
      });
    };
    await assert.rejects(h.open("create"), (error) => error === reason);
    assert.equal(h.held(), false);
    assert.ok(!h.calls.some(([name]) => name === "worker"));
    if (stage === "download") assert.equal(aborted, 1);
    if (["create", "writable", "write"].includes(stage)) assert.equal(cancelled, 1);
  }
});

test("flush/close errors remain failures but still release the page lease", async () => {
  const reason = new Error("flush failed");
  const h = harness({ exists: true, closeError: reason });
  const root = await h.open("open");
  await assert.rejects(root.close(), (error) => error === reason);
  assert.equal(h.held(), false);
});

test("malformed existing disk sizes fail without worker startup or repair", async () => {
  for (const size of [0, 1, -512, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness({ exists: true });
    h.handle.getFile = async () => ({ size });
    await assert.rejects(h.open("open"), /positive multiple/);
    assert.equal(h.held(), false);
    assert.ok(!h.calls.some(([kind]) => ["image", "write", "worker"].includes(kind)));
  }
});

test("all profiles package the shared worker and retain both strict browser cases", () => {
  const recipe = readFileSync(
    new URL("../../distro/wasm64-example/package.nix", import.meta.url),
    "utf8",
  );
  assert.match(recipe, /opfsWorker = import \.\.\/site\/opfs-disk-worker.nix/);
  assert.match(recipe, /kernel = kernel-wasm64;/);
  assert.ok(recipe.includes("--alias:linux-wasm-opfs-device=${../../apps/site/opfs-device.js}"));
  assert.ok(recipe.includes("cp ${opfsWorker}/opfs-disk-worker.js $out/opfs-disk-worker.js"));
  const suites = readFileSync(
    new URL("../../distro/npm/browser-tests.nix", import.meta.url),
    "utf8",
  );
  const group = suites.split("suite = wasm64PythonGitExampleSuite;")[1].split("project =")[0];
  assert.match(group, /runs a Python Git SQLite workspace through standalone browser controls/);
  assert.match(group, /restores a Python Git SQLite workspace through standalone OPFS controls/);
});
