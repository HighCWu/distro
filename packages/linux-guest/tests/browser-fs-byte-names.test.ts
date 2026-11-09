// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFS } from "../src/browser.ts";

function fixture() {
  const files = new Set<string>();
  const names: string[] = [];
  let calls = 0;
  const missing = () => new DOMException("missing", "NotFoundError");
  const file = { kind: "file" };
  const root = {
    kind: "directory",
    async getDirectoryHandle(name: string) {
      calls++;
      names.push(name);
      throw missing();
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      calls++;
      names.push(name);
      if (!files.has(name)) {
        if (!options?.create) throw missing();
        files.add(name);
      }
      return file;
    },
    async removeEntry(name: string) {
      calls++;
      names.push(name);
      files.delete(name);
    },
  } as unknown as FileSystemDirectoryHandle;

  return {
    fs: new BrowserFS(root),
    files,
    names,
    get calls() {
      return calls;
    },
  };
}

test("BrowserFS rejects escaped bytes and malformed UTF-16 before OPFS calls", async () => {
  const malformed = ["\udc80", "\udcff", "\ud800", "\ud800x", "x\udc80"];
  for (const name of malformed) {
    const testFixture = fixture();
    await assert.rejects(testFixture.fs.lookup(testFixture.fs.root, name), { errno: 22 });
    assert.equal(testFixture.calls, 0, `lookup must not reach OPFS for ${JSON.stringify(name)}`);
  }

  const testFixture = fixture();
  const { fs } = testFixture;
  const context = { mode: 0o600, uid: 1, gid: 2 };
  const escaped = "\udc80";
  const rejected = [
    fs.create(fs.root, escaped, 0, context),
    fs.mkdir(fs.root, escaped, context),
    fs.unlink(fs.root, escaped),
    fs.rmdir(fs.root, escaped),
    fs.rename(fs.root, escaped, fs.root, "destination"),
    fs.rename(fs.root, "source", fs.root, escaped),
  ];
  for (const operation of rejected) await assert.rejects(operation, { errno: 22 });
  assert.equal(testFixture.calls, 0, "invalid path components must be rejected before OPFS access");
});

test("BrowserFS preserves valid replacement, emoji and leading BOM names", async () => {
  const { fs, files, names } = fixture();
  const context = { mode: 0o600, uid: 1, gid: 2 };
  const validNames = ["\ufffd", "emoji-\ud83d\ude00", "\ufeffleading-bom"];

  for (const name of validNames) {
    names.length = 0;
    const { node } = await fs.create(fs.root, name, 0, context);
    assert.ok(files.has(name));
    assert.ok(await fs.lookup(fs.root, name));
    assert.ok(names.length > 0);
    assert.ok(names.every((received) => received === name));
    assert.ok(node);
  }
});
