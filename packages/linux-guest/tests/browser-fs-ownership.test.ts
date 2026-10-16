// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserFS } from "../src/browser.ts";

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
