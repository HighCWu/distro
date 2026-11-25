// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { importNinepDirectorySnapshot } from "../src/virtio/ninep/node-directory-snapshot.ts";

const supported = process.platform === "linux" && ["x64", "arm64"].includes(process.arch);

test(
  "bounded Node directory snapshot preserves bytes, modes, empty directories and link text",
  { skip: !supported },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "ninep-snapshot-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = "#!/bin/sh\n";
    const data = Uint8Array.from({ length: 140003 }, (_, i) => i % 251);
    await mkdir(path.join(root, "empty"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "tool"), executable);
    await chmod(path.join(root, "tool"), 0o751);
    await chmod(path.join(root, "empty"), 0o750);
    await chmod(root, 0o750);
    await writeFile(path.join(root, "nested/data"), data);
    await writeFile(path.join(root, "文.txt"), new Uint8Array([3, 4]));
    await writeFile(path.join(root, "\uFEFFfile"), new Uint8Array([5]));
    await symlink("nested/data", path.join(root, "relative"));
    await symlink("/inside-linux", path.join(root, "absolute"));
    const maxBytes =
      Buffer.byteLength(executable) +
      data.length +
      3 +
      "nested/data".length +
      "/inside-linux".length;
    const before = (await readdir("/proc/self/fd")).length;
    const fs = await importNinepDirectorySnapshot(root, { maxBytes, maxEntries: 9 });
    assert.equal((await readdir("/proc/self/fd")).length, before);
    assert.deepEqual(fs.readFile("/nested/data"), data);
    assert.deepEqual(fs.readFile("/文.txt"), new Uint8Array([3, 4]));
    assert.deepEqual(fs.readFile("/\uFEFFfile"), new Uint8Array([5]));
    assert.equal(new TextDecoder().decode(fs.readFile("/tool")), executable);
    assert.equal(fs.getattr("/tool").mode, 0o751);
    assert.equal(fs.getattr("/").mode, 0o750);
    assert.equal(fs.getattr("/empty").mode, 0o750);
    assert.deepEqual(fs.readdir("/empty"), []);
    assert.equal(fs.getattr("/relative").type, "symlink");
    assert.equal(fs.readlink("/relative"), "nested/data");
    assert.equal(fs.readlink("/absolute"), "/inside-linux");
    await writeFile(path.join(root, "tool"), "changed");
    assert.equal(new TextDecoder().decode(fs.readFile("/tool")), executable);
    fs.writeFile("/tool", "snapshot only");
    // A second snapshot reads the source independently of changes to the first.
    assert.equal(
      new TextDecoder().decode(
        (await importNinepDirectorySnapshot(root, { maxBytes, maxEntries: 9 })).readFile("/tool"),
      ),
      "changed",
    );
  },
);

test(
  "snapshot enforces mandatory budgets and closes descriptors on failure",
  { skip: !supported },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "ninep-snapshot-limit-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "directory"));
    await writeFile(path.join(root, "directory/file"), new Uint8Array([0, 1, 255]));
    for (const invalid of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        importNinepDirectorySnapshot(root, { maxBytes: invalid, maxEntries: 3 }),
        RangeError,
      );
      await assert.rejects(
        importNinepDirectorySnapshot(root, { maxBytes: 3, maxEntries: invalid }),
        RangeError,
      );
    }
    const before = (await readdir("/proc/self/fd")).length;
    await assert.rejects(
      importNinepDirectorySnapshot(`${root}/\uD800`, { maxBytes: 3, maxEntries: 3 }),
      { code: "EINVAL" },
    );
    for (const limits of [
      { maxBytes: 2, maxEntries: 3 },
      { maxBytes: 3, maxEntries: 2 },
    ]) {
      await assert.rejects(importNinepDirectorySnapshot(root, limits), { code: "E2BIG" });
      assert.equal((await readdir("/proc/self/fd")).length, before);
    }
    const fs = await importNinepDirectorySnapshot(root, { maxBytes: 3, maxEntries: 3 });
    assert.deepEqual(fs.readFile("/directory/file"), new Uint8Array([0, 1, 255]));
    assert.equal((await readdir("/proc/self/fd")).length, before);
  },
);
