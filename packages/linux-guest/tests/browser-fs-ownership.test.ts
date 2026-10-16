// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFS } from "../src/browser.ts";

test("BrowserFS validates all timestamps before truncation or metadata changes", async () => {
  let streams = 0;
  const fs = new BrowserFS({
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("file", "TypeMismatchError");
    },
    async getFileHandle() {
      return {
        kind: "file",
        async getFile() {
          return new Blob(["original"]);
        },
        async createWritable() {
          streams++;
          throw new Error("invalid timestamps must not open a stream");
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle);
  const { node } = await fs.create(fs.root, "file", 2, { mode: 0o600, uid: 1, gid: 2 });
  const timestamp = { seconds: -1n, nanoseconds: 500_000_000 };
  await fs.setattr(node, { atime: timestamp, mtime: timestamp, ctime: timestamp });
  const before = await fs.getattr(node);
  timestamp.nanoseconds = -1;
  assert.deepEqual(await fs.getattr(node), before, "caller must not retain a metadata reference");
  for (const field of ["atime", "mtime", "ctime"] as const) {
    for (const nanoseconds of [-1, 1_000_000_000, 0.5, NaN, Infinity]) {
      await assert.rejects(
        fs.setattr(node, {
          size: 0n,
          mode: 0o777,
          uid: 99,
          gid: 99,
          [field]: { seconds: 1n, nanoseconds },
        }),
        { errno: 22 },
      );
      assert.deepEqual(await fs.getattr(node), before);
    }
  }
  assert.equal(streams, 0);
  const wide = { seconds: 9_007_199_254_740_993n };
  await fs.setattr(node, { atime: wide, mtime: wide, ctime: wide });
  const attrs = await fs.getattr(node);
  for (const field of ["atime", "mtime", "ctime"] as const) {
    assert.deepEqual(attrs[field], { ...wide, nanoseconds: 0 });
  }
  await fs.setattr(node, { atime: "now", mtime: "now" });
  const current = await fs.getattr(node);
  assert.equal(typeof current.mtime!.seconds, "bigint");
  assert.ok(current.mtime!.nanoseconds! >= 0 && current.mtime!.nanoseconds! < 1_000_000_000);
});

test("BrowserFS serializes exclusive creation and recovers its namespace queue after rejection", async () => {
  const entries = new Map<string, { kind: "file" | "directory" }>();
  let created = 0;
  async function entry(name: string, kind: "file" | "directory", options?: { create?: boolean }) {
    let value = entries.get(name);
    if (!value) {
      if (!options?.create) throw new DOMException("missing", "NotFoundError");
      value = { kind };
      entries.set(name, value);
      created++;
    }
    if (value.kind !== kind) throw new DOMException("wrong kind", "TypeMismatchError");
    return value;
  }
  const fs = new BrowserFS({
    kind: "directory",
    getDirectoryHandle: (name: string, options?: { create?: boolean }) =>
      entry(name, "directory", options),
    getFileHandle: (name: string, options?: { create?: boolean }) => entry(name, "file", options),
    async removeEntry(name: string) {
      entries.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle);
  const context = { mode: 0o600, uid: 1, gid: 2 };
  const results = await Promise.allSettled([
    fs.create(fs.root, "file", 0xc2, context),
    fs.create(fs.root, "file", 0xc2, { mode: 0o644, uid: 3, gid: 4 }),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[0].status !== "fulfilled" || results[1].status !== "rejected") assert.fail();
  assert.equal(results[1].reason.errno, 17);
  assert.equal(created, 1, "the losing exclusive request must not create a backing entry");
  const directories = await Promise.allSettled([
    fs.mkdir(fs.root, "directory", context),
    fs.mkdir(fs.root, "directory", context),
  ]);
  assert.equal(directories[0].status, "fulfilled");
  assert.equal(directories[1].status, "rejected");
  if (directories[1].status === "rejected") assert.equal(directories[1].reason.errno, 17);
  const [removed, recreated] = await Promise.all([
    fs.unlink(fs.root, "file"),
    fs.create(fs.root, "file", 0xc2, context),
  ]);
  assert.equal(removed, undefined);
  assert.notEqual(recreated.node, results[0].value.node);
  await fs.rmdir(fs.root, "directory");
  await fs.mkdir(fs.root, "directory", context);
  assert.equal(created, 4, "rejections must not strand later namespace operations");
});

test("BrowserFS append handles resolve EOF after earlier queued commits", async () => {
  let content = "base";
  const file = {
    kind: "file",
    async getFile() {
      return new Blob([content]);
    },
    async createWritable() {
      let staged = content,
        position = 0;
      return {
        async seek(offset: number) {
          position = offset;
        },
        async write(data: ArrayBuffer) {
          const text = new TextDecoder().decode(data);
          staged = staged.slice(0, position) + text + staged.slice(position + text.length);
        },
        async close() {
          content = staged;
        },
      };
    },
  };
  const fs = new BrowserFS({
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("file", "TypeMismatchError");
    },
    async getFileHandle() {
      return file;
    },
  } as unknown as FileSystemDirectoryHandle);
  const { node, handle } = await fs.create(fs.root, "file", 0x402, { mode: 0o600, uid: 0, gid: 0 });
  const other = await fs.open(node, 0x402);
  assert.deepEqual(
    await Promise.all([
      fs.write(node, handle, 0n, new TextEncoder().encode("A")),
      fs.write(node, other, 0n, new TextEncoder().encode("B")),
    ]),
    [1, 1],
  );
  assert.equal(content, "baseAB");
  const positioned = await fs.open(node, 2);
  await fs.write(node, positioned, 0n, new TextEncoder().encode("Z"));
  assert.equal(content, "ZaseAB", "ordinary handles retain positioned writes");
  await fs.write(node, handle, 0n, new TextEncoder().encode("X"), 2);
  assert.equal(content, "XaseAB", "current flags can disable append on an append handle");
  await fs.write(node, positioned, 0n, new TextEncoder().encode("C"), 0x402);
  assert.equal(content, "XaseABC", "current flags can enable append on a positioned handle");
});

test("BrowserFS rejects invalid I/O ranges before touching storage", async () => {
  let reads = 0;
  let writes = 0;
  const fs = new BrowserFS({
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("file", "TypeMismatchError");
    },
    async getFileHandle() {
      return {
        kind: "file",
        async getFile() {
          reads++;
          return new Blob(["abcdef"]);
        },
        async createWritable() {
          writes++;
          assert.fail("invalid writes must not create a stream");
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle);
  const node = await fs.lookup(fs.root, "file");
  assert.ok(node);
  const handle = await fs.open(node, 0);
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  for (const [offset, length] of [
    [-1n, 1],
    [max + 1n, 0],
    [0n, -1],
    [0n, 0.5],
    [0n, NaN],
    [0n, Infinity],
    [0n, Number.MAX_SAFE_INTEGER + 1],
    [max, 1],
  ] as const) {
    await assert.rejects(fs.read(node, handle, offset, length), { errno: 22 });
  }
  for (const offset of [-1n, max, max + 1n]) {
    await assert.rejects(fs.write(node, handle, offset, Uint8Array.of(1)), { errno: 22 });
  }
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.deepEqual(await fs.read(node, handle, 2n, 3), new TextEncoder().encode("cde"));
  assert.equal((await fs.read(node, handle, max, 0)).byteLength, 0);
  assert.equal((await fs.read(node, handle, 100n, 3)).byteLength, 0);
});

test("BrowserFS file rename waits for pending source writes before copying", async () => {
  const files = new Map([["source", "before"]]);
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let snapshots = 0;
  const fileHandle = (name: string) => ({
    kind: "file",
    async getFile() {
      if (name === "source") snapshots++;
      return new Blob([files.get(name)!]);
    },
    async createWritable() {
      let pending = "";
      const receive = (chunk: Uint8Array) => {
        pending += new TextDecoder().decode(chunk);
      };
      const commit = () => {
        files.set(name, pending);
      };
      return Object.assign(new WritableStream({ write: receive, close: commit }), {
        async seek() {},
        async write(data: ArrayBuffer) {
          receive(new Uint8Array(data));
        },
        async close() {
          if (name === "source") {
            closing.resolve();
            await release.promise;
          }
          commit();
        },
      });
    },
  });
  const fs = new BrowserFS({
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("not a directory", "TypeMismatchError");
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, "");
      }
      return fileHandle(name);
    },
    async removeEntry(name: string) {
      files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle);
  const node = await fs.lookup(fs.root, "source");
  assert.ok(node);
  const handle = await fs.open(node, 0);
  const writing = fs.write(node, handle, 0n, new TextEncoder().encode("after!"));
  await closing.promise;
  const moving = fs.rename(fs.root, "source", fs.root, "destination");
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(snapshots, 0, "copy must wait for the source stream to commit");
  } finally {
    release.resolve();
    await writing;
    await moving;
  }
  assert.equal(files.get("destination"), "after!");
  assert.equal(files.has("source"), false);
  assert.equal(
    await fs.lookup(fs.root, "destination"),
    node,
    "open source identity follows rename",
  );
});

function replacementFixture(failed: boolean, denyRemoval = false) {
  const files = new Map([
    ["source", "source"],
    ["target", "before"],
  ]);
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let targetStreams = 0;
  const removals: string[] = [];
  const fs = new BrowserFS({
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("file", "TypeMismatchError");
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException("missing", "NotFoundError");
        files.set(name, "");
      }
      return {
        kind: "file",
        async getFile() {
          return new File([files.get(name)!], name);
        },
        async createWritable(options?: { keepExistingData?: boolean }) {
          const first = name === "target" && ++targetStreams === 1;
          let pending = options?.keepExistingData ? files.get(name)! : "";
          const commit = () => {
            files.set(name, pending);
          };
          return Object.assign(
            new WritableStream<Uint8Array>({
              write(bytes) {
                pending += new TextDecoder().decode(bytes);
              },
              close: commit,
            }),
            {
              async seek() {},
              async write(data: ArrayBuffer) {
                pending = new TextDecoder().decode(data);
              },
              async truncate(size: number) {
                pending = pending.slice(0, size);
              },
              async close() {
                if (first) {
                  closing.resolve();
                  await release.promise;
                  if (failed) throw new DOMException("full", "QuotaExceededError");
                }
                commit();
              },
            },
          );
        },
      };
    },
    async removeEntry(name: string) {
      removals.push(name);
      if (name === "target" && denyRemoval) {
        denyRemoval = false;
        throw new DOMException("denied", "NotAllowedError");
      }
      files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle);
  return { fs, files, closing, release, removals };
}

for (const operation of ["write", "truncate"] as const) {
  for (const failed of [false, true]) {
    test(`BrowserFS replacement waits for target ${operation} (failed: ${failed})`, async () => {
      const { fs, files, closing, release, removals } = replacementFixture(failed);
      const source = await fs.lookup(fs.root, "source");
      const target = await fs.lookup(fs.root, "target");
      assert.ok(source && target);
      const sourceHandle = await fs.open(source, 2);
      const targetHandle = await fs.open(target, 2);
      const mutation =
        operation === "write"
          ? fs.write(target, targetHandle, 0n, new TextEncoder().encode("after!"))
          : fs.setattr(target, { size: 2n });
      const result = failed ? assert.rejects(mutation, { errno: 28 }) : mutation;
      await closing.promise;
      const moving = fs.rename(fs.root, "source", fs.root, "target");
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(removals, [], "replacement must wait for the destination stream");
      } finally {
        release.resolve();
        await result;
        await moving;
      }
      assert.equal(files.get("target"), "source");
      assert.equal(files.has("source"), false);
      assert.equal(await fs.lookup(fs.root, "target"), source);
      await assert.rejects(fs.write(target, targetHandle, 0n, Uint8Array.of(1)), { errno: 2 });
      await fs.write(source, sourceHandle, 0n, new TextEncoder().encode("updated"));
      assert.equal(files.get("target"), "updated");
    });
  }
}

test("BrowserFS failed replacement removal releases both file queues and namespace queue", async () => {
  const { fs, files, release } = replacementFixture(false, true);
  release.resolve();
  const source = await fs.lookup(fs.root, "source");
  const target = await fs.lookup(fs.root, "target");
  assert.ok(source && target);
  const sourceHandle = await fs.open(source, 2);
  const targetHandle = await fs.open(target, 2);
  await assert.rejects(fs.rename(fs.root, "source", fs.root, "target"), { errno: 13 });
  assert.equal(await fs.lookup(fs.root, "source"), source);
  assert.equal(await fs.lookup(fs.root, "target"), target);
  await fs.write(source, sourceHandle, 0n, new TextEncoder().encode("new source"));
  await fs.write(target, targetHandle, 0n, new TextEncoder().encode("new target"));
  assert.equal(files.get("target"), "new target");
  await fs.rename(fs.root, "source", fs.root, "target");
  assert.equal(files.get("target"), "new source");
});

for (const operation of ["write", "truncate"] as const) {
  for (const failed of [false, true]) {
    test(`BrowserFS unlink waits for an earlier ${operation} (failed: ${failed})`, async () => {
      const closing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let content = "before";
      let exists = true;
      let streams = 0;
      let removals = 0;
      const fs = new BrowserFS({
        kind: "directory",
        async getDirectoryHandle() {
          throw new DOMException("file", "TypeMismatchError");
        },
        async getFileHandle(_name: string, options?: { create?: boolean }) {
          if (!exists) {
            if (!options?.create) throw new DOMException("missing", "NotFoundError");
            exists = true;
            content = "";
          }
          return {
            kind: "file",
            async getFile() {
              return new File([content], "file");
            },
            async createWritable() {
              const first = ++streams === 1;
              let pending = content;
              return {
                async seek() {},
                async write(data: ArrayBuffer) {
                  pending = new TextDecoder().decode(data);
                },
                async truncate(size: number) {
                  pending = pending.slice(0, size);
                },
                async close() {
                  if (first) {
                    closing.resolve();
                    await release.promise;
                    if (failed) throw new DOMException("full", "QuotaExceededError");
                  }
                  content = pending;
                },
                async abort() {},
              };
            },
          };
        },
        async removeEntry() {
          removals++;
          exists = false;
        },
      } as unknown as FileSystemDirectoryHandle);
      const node = await fs.lookup(fs.root, "file");
      assert.ok(node);
      const handle = await fs.open(node, 2);
      const mutation =
        operation === "write"
          ? fs.write(node, handle, 0n, new TextEncoder().encode("after!"))
          : fs.setattr(node, { size: 2n });
      const result = failed ? assert.rejects(mutation, { errno: 28 }) : mutation;
      await closing.promise;
      const deleting = fs.unlink(fs.root, "file");
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(removals, 0, "removal must wait for commit or abort");
      } finally {
        release.resolve();
        await result;
        await deleting;
      }
      assert.equal(removals, 1);
      const replacement = await fs.create(fs.root, "file", 0xc2, { mode: 0o600, uid: 0, gid: 0 });
      assert.notEqual(replacement.node, node);
      const before = streams;
      await assert.rejects(fs.write(node, handle, 0n, Uint8Array.of(1)), { errno: 2 });
      assert.equal(streams, before, "stale writes must not open the replacement");
      await fs.write(replacement.node, replacement.handle, 0n, new TextEncoder().encode("new"));
      assert.equal(content, "new", "later namespace and file operations still work");
    });
  }
}

test("BrowserFS failed unlink keeps the node usable and releases both queues", async () => {
  let fail = true;
  const fs = new BrowserFS({
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("file", "TypeMismatchError");
    },
    async getFileHandle() {
      return {
        kind: "file",
        async createWritable() {
          return { async seek() {}, async write() {}, async close() {} };
        },
      };
    },
    async removeEntry() {
      if (fail) {
        fail = false;
        throw new DOMException("denied", "NotAllowedError");
      }
    },
  } as unknown as FileSystemDirectoryHandle);
  const node = await fs.lookup(fs.root, "file");
  assert.ok(node);
  const handle = await fs.open(node, 2);
  await assert.rejects(fs.unlink(fs.root, "file"), { errno: 13 });
  assert.equal(await fs.write(node, handle, 0n, Uint8Array.of(1)), 1);
  await fs.unlink(fs.root, "file");
  await assert.rejects(fs.write(node, handle, 0n, Uint8Array.of(1)), { errno: 2 });
});

test("BrowserFS same-path rename still requires the source to exist", async () => {
  let exists = false;
  const root = {
    kind: "directory",
    async getDirectoryHandle() {
      throw new DOMException("missing", "NotFoundError");
    },
    async getFileHandle() {
      if (!exists) throw new DOMException("missing", "NotFoundError");
      return { kind: "file" };
    },
    async removeEntry() {
      assert.fail("same-path rename must not remove data");
    },
  } as unknown as FileSystemDirectoryHandle;
  const fs = new BrowserFS(root);
  await assert.rejects(fs.rename(fs.root, "entry", fs.root, "entry"), {
    name: "FSError",
    errno: 2,
  });
  exists = true;
  const node = await fs.lookup(fs.root, "entry");
  await fs.rename(fs.root, "entry", fs.root, "entry");
  assert.equal(await fs.lookup(fs.root, "entry"), node);
});

for (const operation of ["flush", "fsync"] as const) {
  test(`BrowserFS ${operation} waits for an earlier write to commit`, async () => {
    const closing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let committed = false;
    const fs = new BrowserFS({
      kind: "directory",
      async getDirectoryHandle() {
        throw new DOMException("file", "TypeMismatchError");
      },
      async getFileHandle() {
        return {
          kind: "file",
          async createWritable() {
            return {
              async seek() {},
              async write() {},
              async close() {
                closing.resolve();
                await release.promise;
                committed = true;
              },
            };
          },
        };
      },
    } as unknown as FileSystemDirectoryHandle);
    const node = await fs.lookup(fs.root, "file");
    assert.ok(node);
    const handle = await fs.open(node, 0);
    const writing = fs.write(node, handle, 0n, Uint8Array.of(1));
    await closing.promise;
    let synchronized = false;
    const syncing = (
      operation === "flush" ? fs.flush(node, handle) : fs.fsync(node, handle, false)
    ).then(() => {
      synchronized = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(synchronized, false, "synchronization must wait for stream close");
    } finally {
      release.resolve();
      await writing;
      await syncing;
    }
    assert.equal(committed, true);
    assert.equal(synchronized, true);
  });
}

for (const stage of ["seek", "write", "truncate", "close", "success"]) {
  test(`BrowserFS commits only successful writes: ${stage}`, async () => {
    const calls: string[] = [];
    const failure = new DOMException("disk full", "QuotaExceededError");
    const perform = async (name: string) => {
      calls.push(name);
      if (stage === name) throw failure;
    };
    const file = {
      kind: "file",
      async createWritable() {
        return {
          seek: () => perform("seek"),
          write: () => perform("write"),
          truncate: () => perform("truncate"),
          close: () => perform("close"),
          async abort() {
            calls.push("abort");
            throw new Error("abort failed too");
          },
        };
      },
    };
    const fs = new BrowserFS({
      kind: "directory",
      async getDirectoryHandle() {
        throw new DOMException("file", "TypeMismatchError");
      },
      async getFileHandle() {
        return file;
      },
    } as unknown as FileSystemDirectoryHandle);
    const node = await fs.lookup(fs.root, "file");
    assert.ok(node);
    const handle = await fs.open(node, 0);
    const result =
      stage === "truncate"
        ? fs.setattr(node, { size: 0n })
        : fs.write(node, handle, 0n, Uint8Array.of(1));
    if (stage === "success") {
      assert.equal(await result, 1);
      assert.deepEqual(calls, ["seek", "write", "close"]);
    } else {
      await assert.rejects(result, { name: "FSError", errno: 28, message: "disk full" });
      const expected =
        stage === "truncate"
          ? ["truncate"]
          : ["seek", "write", "close"].slice(0, ["seek", "write", "close"].indexOf(stage) + 1);
      assert.deepEqual(calls, [...expected, "abort"]);
    }
  });
}

test("BrowserFS rejects nodes from another adapter before storage access", async () => {
  let lookups = 0;
  const root = {
    kind: "directory",
    async getDirectoryHandle() {
      lookups++;
      return { kind: "directory" };
    },
  } as unknown as FileSystemDirectoryHandle;
  // Even adapters pointing at the same backing handle have independent nodes.
  const first = new BrowserFS(root);
  const second = new BrowserFS(root);
  assert.equal((await first.getattr(first.root)).size, 0n);
  await assert.rejects(second.getattr(first.root), { name: "FSError", errno: 22 });
  await assert.rejects(second.lookup(first.root, "child"), { name: "FSError", errno: 22 });
  assert.equal(lookups, 0);
  const child = await first.lookup(first.root, "child");
  assert.ok(child);
  assert.equal((await first.getattr(child)).size, 0n);
  await assert.rejects(second.getattr(child), { name: "FSError", errno: 22 });
  assert.equal(lookups, 1);
  assert.equal((await second.getattr(second.root)).size, 0n);
});
