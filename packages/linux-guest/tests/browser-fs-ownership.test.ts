// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFS } from "../src/browser.ts";

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
