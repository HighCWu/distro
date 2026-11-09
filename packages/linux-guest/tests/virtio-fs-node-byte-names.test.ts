// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { decode_linux_bytes } from "@lowland/kernel";
import { NodeFS } from "../src/node.ts";

const linux_open = { readonly: 0, readwrite: 2 } as const;
const temporary = await mkdtemp(path.join(tmpdir(), "linux-guest-byte-names-"));
after(() => rm(temporary, { recursive: true, force: true }));

test(
  "NodeFS preserves invalid POSIX filename and symlink bytes through host path calls",
  { skip: process.platform === "win32" },
  async () => {
    const rootBytes = Buffer.concat([Buffer.from(`${temporary}${path.sep}root-`), Buffer.of(0xff)]);
    await mkdir(rootBytes);
    const rootPath = decode_linux_bytes(rootBytes);
    const fs = new NodeFS(rootPath);
    const invalidName = decode_linux_bytes(Uint8Array.of(0xff));
    const targetName = decode_linux_bytes(Uint8Array.of(0xfe));
    const linkName = decode_linux_bytes(Uint8Array.of(0xfd));
    const movedName = decode_linux_bytes(Uint8Array.of(0xfc));
    const replacementName = "\ufffd";
    const emojiName = "file-🧪";
    const context = { mode: 0o100600, uid: process.getuid!(), gid: process.getgid!() };

    const created = await fs.create(fs.root, invalidName, linux_open.readwrite, context);
    await fs.write(created.node, created.handle, 0n, new TextEncoder().encode("raw-name"));
    await fs.release(created.node, created.handle);
    for (const name of [targetName, replacementName, emojiName]) {
      const entry = await fs.create(fs.root, name, linux_open.readonly, context);
      await fs.release(entry.node, entry.handle);
    }

    const file = (await fs.lookup(fs.root, invalidName))!;
    const handle = await fs.open(file, linux_open.readonly);
    try {
      assert.equal(new TextDecoder().decode(await fs.read(file, handle, 0n, 8)), "raw-name");
    } finally {
      await fs.release(file, handle);
    }

    const link = await fs.symlink(fs.root, linkName, invalidName, context);
    assert.equal(await fs.readlink(link), invalidName);
    const directory = await fs.opendir(fs.root);
    try {
      const names = (await fs.readdir(fs.root, directory)).map(({ name }) => name);
      assert.ok(names.includes(invalidName));
      assert.ok(names.includes(replacementName));
      assert.ok(names.includes(emojiName));
      assert.ok(names.includes(targetName));
      assert.ok(names.includes(linkName));
      assert.equal(new Set(names).size, names.length);
    } finally {
      await fs.releasedir(fs.root, directory);
    }

    await fs.rename(fs.root, invalidName, fs.root, movedName);
    assert.equal(await fs.lookup(fs.root, movedName), file);
    await fs.unlink(fs.root, linkName);
    await fs.unlink(fs.root, movedName);
    const stats = await fs.statfs(fs.root);
    assert.ok(stats.blockSize !== undefined && stats.blockSize > 0);

    await assert.rejects(fs.lookup(fs.root, "\ud800"), { errno: 22 });
    await assert.rejects(fs.lookup(fs.root, "\udc00"), { errno: 22 });
  },
);
