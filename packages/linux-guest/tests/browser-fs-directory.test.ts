// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFS } from "../src/browser.ts";

function directoryFixture() {
  const files = new Map([
    ["source/known", "before"],
    ["source/late", "late"],
  ]);
  const directories = new Set(["", "source"]);
  const closing = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const copying = Promise.withResolvers<void>();
  const releaseCopy = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const listingStarted = Promise.withResolvers<void>();
  const releaseListing = Promise.withResolvers<void>();
  let holdLookup = false;
  let holdListing = false;
  let holdWrite = true;
  let heldName = "source/known";
  let copyReads = 0;
  let failCopy = false;
  const missing = () => new DOMException("missing", "NotFoundError");
  const fileHandle = (name: string) => ({
    kind: "file",
    async getFile() {
      if (!files.has(name)) throw missing();
      if (name === "source/known") {
        copyReads++;
        copying.resolve();
        await releaseCopy.promise;
        if (failCopy) {
          failCopy = false;
          throw new Error("copy failed");
        }
      }
      return new File([files.get(name)!], name);
    },
    async createWritable(options?: { keepExistingData?: boolean }) {
      if (!files.has(name)) throw missing();
      let pending = options?.keepExistingData ? files.get(name)! : "";
      const commit = () => {
        files.set(name, pending);
      };
      return Object.assign(
        new WritableStream<Uint8Array>({
          write(chunk) {
            pending += new TextDecoder().decode(chunk);
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
            if (name === heldName && holdWrite) {
              holdWrite = false;
              closing.resolve();
              await releaseWrite.promise;
            }
            commit();
          },
        },
      );
    },
  });
  const directoryHandle = (name: string): object => ({
    kind: "directory",
    async getDirectoryHandle(child: string, options?: { create?: boolean }) {
      const key = name ? `${name}/${child}` : child;
      if (files.has(key)) throw new DOMException("file", "TypeMismatchError");
      if (!directories.has(key)) {
        if (!options?.create) throw missing();
        directories.add(key);
      }
      return directoryHandle(key);
    },
    async getFileHandle(child: string, options?: { create?: boolean }) {
      const key = name ? `${name}/${child}` : child;
      if (key === "source/late" && holdLookup) {
        holdLookup = false;
        lookupStarted.resolve();
        await releaseLookup.promise;
      }
      if (!files.has(key)) {
        if (!options?.create) throw missing();
        files.set(key, "");
      }
      return fileHandle(key);
    },
    async *entries() {
      const prefix = name ? `${name}/` : "";
      if (name === "source" && holdListing) {
        holdListing = false;
        listingStarted.resolve();
        await releaseListing.promise;
      }
      for (const key of directories) {
        const relative = key.slice(prefix.length);
        if (key && key !== name && key.startsWith(prefix) && !relative.includes("/"))
          yield [relative, directoryHandle(key)];
      }
      for (const key of files.keys()) {
        const relative = key.slice(prefix.length);
        if (key.startsWith(prefix) && !relative.includes("/")) yield [relative, fileHandle(key)];
      }
    },
    async removeEntry(child: string) {
      const key = name ? `${name}/${child}` : child;
      for (const directory of directories)
        if (directory === key || directory.startsWith(`${key}/`)) directories.delete(directory);
      for (const file of files.keys())
        if (file === key || file.startsWith(`${key}/`)) files.delete(file);
    },
  });
  return {
    fs: new BrowserFS(directoryHandle("") as FileSystemDirectoryHandle),
    files,
    directories,
    holdFile(name: string) {
      heldName = name;
    },
    closing,
    releaseWrite,
    copying,
    releaseCopy,
    get copyReads() {
      return copyReads;
    },
    failCopy() {
      failCopy = true;
    },
    lookupStarted,
    releaseLookup,
    listingStarted,
    releaseListing,
    delayQueries() {
      holdLookup = true;
      holdListing = true;
    },
  };
}

test(
  "BrowserFS directory move drains existing writes and delays new subtree operations",
  { timeout: 2000 },
  async (t) => {
    const fixture = directoryFixture();
    const { fs, files, closing, releaseWrite, copying, releaseCopy } = fixture;
    t.after(() => {
      releaseWrite.resolve();
      releaseCopy.resolve();
    });
    const directory = await fs.lookup(fs.root, "source");
    assert.ok(directory);
    const node = await fs.lookup(directory, "known");
    assert.ok(node);
    const handle = await fs.open(node, 2);
    const writing = fs.write(node, handle, 0n, new TextEncoder().encode("after!"));
    await closing.promise;
    const moving = fs.rename(fs.root, "source", fs.root, "destination");
    void moving.catch(() => {});
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        fixture.copyReads,
        0,
        "directory snapshots must wait for earlier descendant writes",
      );
    } finally {
      releaseWrite.resolve();
      await writing;
    }
    await copying.promise;
    let lookedUp = false;
    let listed = false;
    let rewritten = false;
    let destinationSeen = false;
    let rootListed = false;
    const lookup = fs.lookup(directory, "late").then((node) => {
      lookedUp = true;
      return node;
    });
    const listing = fs.readdir(directory, await fs.opendir(directory)).then((entries) => {
      listed = true;
      return entries;
    });
    const rewriting = fs.write(node, handle, 0n, new TextEncoder().encode("latest")).then(() => {
      rewritten = true;
    });
    const destination = fs.lookup(fs.root, "destination").then((node) => {
      destinationSeen = true;
      return node;
    });
    const rootListing = fs.readdir(fs.root, await fs.opendir(fs.root)).then((entries) => {
      rootListed = true;
      return entries;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(lookedUp, false);
      assert.equal(listed, false);
      assert.equal(rewritten, false);
      assert.equal(destinationSeen, false, "partial destinations must not leak through lookup");
      assert.equal(rootListed, false, "ancestor listings must wait for relocation");
    } finally {
      releaseCopy.resolve();
      await moving;
    }
    const late = await lookup;
    assert.ok(late);
    assert.equal((await listing).length, 2);
    assert.equal(await destination, directory);
    assert.deepEqual(
      (await rootListing).map((entry) => entry.name),
      ["destination"],
    );
    await rewriting;
    await fs.write(late, await fs.open(late, 2), 0n, new TextEncoder().encode("new late"));
    assert.equal(files.get("destination/known"), "latest");
    assert.equal(files.get("destination/late"), "new late");
    assert.equal(files.has("source/known"), false);
    assert.equal(await fs.lookup(fs.root, "destination"), directory);
  },
);

for (const operation of ["write", "truncate"] as const) {
  test(
    `BrowserFS directory relocation waits for nested ${operation}`,
    { timeout: 2000 },
    async (t) => {
      const fixture = directoryFixture();
      const { fs, files, directories, closing, releaseWrite, releaseCopy } = fixture;
      t.after(() => {
        releaseWrite.resolve();
        releaseCopy.resolve();
      });
      directories.add("source/nested");
      files.set("source/nested/deep", "original");
      fixture.holdFile("source/nested/deep");
      releaseCopy.resolve();
      const directory = await fs.lookup(fs.root, "source");
      assert.ok(directory);
      const nested = await fs.lookup(directory, "nested");
      assert.ok(nested);
      const node = await fs.lookup(nested, "deep");
      assert.ok(node);
      const mutation =
        operation === "write"
          ? fs.write(node, await fs.open(node, 2), 0n, new TextEncoder().encode("changed"))
          : fs.setattr(node, { size: 2n });
      await closing.promise;
      const moving = fs.rename(fs.root, "source", fs.root, "destination");
      void moving.catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(fixture.copyReads, 0);
      releaseWrite.resolve();
      await mutation;
      await moving;
      assert.equal(files.get("destination/nested/deep"), operation === "write" ? "changed" : "or");
      assert.equal(await fs.lookup(directory, "nested"), nested);
      assert.equal(await fs.lookup(nested, "deep"), node);
    },
  );
}

test(
  "BrowserFS retries lookups and listings already in flight across directory relocation",
  { timeout: 2000 },
  async (t) => {
    const fixture = directoryFixture();
    const {
      fs,
      files,
      releaseWrite,
      releaseCopy,
      lookupStarted,
      releaseLookup,
      listingStarted,
      releaseListing,
    } = fixture;
    t.after(() => {
      releaseCopy.resolve();
      releaseLookup.resolve();
      releaseListing.resolve();
    });
    releaseWrite.resolve();
    const directory = await fs.lookup(fs.root, "source");
    assert.ok(directory);
    fixture.delayQueries();
    const lookup = fs.lookup(directory, "late");
    const listing = fs.readdir(directory, await fs.opendir(directory));
    await Promise.all([lookupStarted.promise, listingStarted.promise]);
    const moving = fs.rename(fs.root, "source", fs.root, "destination");
    await fixture.copying.promise;
    releaseCopy.resolve();
    await moving;
    releaseLookup.resolve();
    releaseListing.resolve();
    const late = await lookup;
    assert.ok(late);
    assert.equal((await listing).length, 2);
    await fs.write(late, await fs.open(late, 2), 0n, new TextEncoder().encode("after move"));
    assert.equal(files.get("destination/late"), "after move");
  },
);

test(
  "BrowserFS failed directory copy releases subtree and namespace operations",
  { timeout: 2000 },
  async () => {
    const fixture = directoryFixture();
    const { fs, files, releaseWrite, releaseCopy } = fixture;
    releaseWrite.resolve();
    releaseCopy.resolve();
    fixture.failCopy();
    const directory = await fs.lookup(fs.root, "source");
    assert.ok(directory);
    await assert.rejects(fs.rename(fs.root, "source", fs.root, "destination"), { errno: 5 });
    const node = await fs.lookup(directory, "known");
    assert.ok(node);
    const handle = await fs.open(node, 2);
    await fs.write(node, handle, 0n, new TextEncoder().encode("retry"));
    await fs.rename(fs.root, "source", fs.root, "destination");
    assert.equal(files.get("destination/known"), "retry");
  },
);

test(
  "BrowserFS invalid directory destination releases the relocation barrier",
  { timeout: 2000 },
  async () => {
    const { fs, releaseWrite, releaseCopy } = directoryFixture();
    releaseWrite.resolve();
    releaseCopy.resolve();
    const directory = await fs.lookup(fs.root, "source");
    assert.ok(directory);
    await assert.rejects(fs.rename(fs.root, "source", directory, "nested"), { errno: 22 });
    const node = await fs.lookup(directory, "known");
    assert.ok(node);
    await fs.write(node, await fs.open(node, 2), 0n, Uint8Array.of(1));
    await fs.rename(fs.root, "source", fs.root, "destination");
  },
);
