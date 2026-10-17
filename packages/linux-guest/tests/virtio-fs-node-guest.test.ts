// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSystemDevice } from "@lowland/kernel";
import { NodeFS } from "../src/node.ts";
import { SeekMode, SystemError } from "../src/index.ts";
import { guest_test } from "./fixture.ts";

guest_test("Node directory sharing through Linux", async (t, fixture) => {
  const shared = await mkdtemp(path.join(tmpdir(), "linux-guest-node-mount-"));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const filesystem = new NodeFS(shared);
  const guest = await fixture.spawn([
    fileSystemDevice(filesystem, { tag: "node-test", cache: false }),
  ]);
  await guest.fs.mkdir("/tmp/shared", { recursive: true });
  await guest.mount("node-test", "/tmp/shared", { type: "virtiofs" });

  try {
    await t.test("reads and writes both sides of the mount", async () => {
      await guest.fs.writeTextFile("/tmp/shared/from-linux", "Linux data");
      assert.equal(await readFile(path.join(shared, "from-linux"), "utf8"), "Linux data");

      await writeFile(path.join(shared, "from-host"), "host data");
      assert.equal(await guest.fs.readTextFile("/tmp/shared/from-host"), "host data");

      await guest.fs.rename("/tmp/shared/from-linux", "/tmp/shared/renamed");
      assert.equal(await readFile(path.join(shared, "renamed"), "utf8"), "Linux data");
    });

    await t.test("synchronizes the shared directory through Linux FSYNCDIR", async () => {
      const directory = await guest.fs.open("/tmp/shared", { read: true });
      try {
        await guest.fs.writeTextFile("/tmp/shared/synced-entry", "published");
        await directory.sync();
        assert.equal(await readFile(path.join(shared, "synced-entry"), "utf8"), "published");
      } finally {
        await directory.close();
      }
    });

    await t.test("rejects missing self rename and preserves an existing self rename", async () => {
      await assert.rejects(
        guest.fs.rename("/tmp/shared/missing-self", "/tmp/shared/missing-self"),
        (error) => error instanceof SystemError && error.code === "ENOENT",
      );
      await guest.fs.writeTextFile("/tmp/shared/self", "unchanged");
      const before = await guest.fs.stat("/tmp/shared/self");
      await guest.fs.rename("/tmp/shared/self", "/tmp/shared/self");
      const after = await guest.fs.stat("/tmp/shared/self");
      assert.equal(after.ino, before.ino);
      assert.equal(await guest.fs.readTextFile("/tmp/shared/self"), "unchanged");
    });

    await t.test("replacement rename preserves the old open inode", async () => {
      await guest.fs.writeTextFile("/tmp/shared/publish", "old");
      await guest.fs.writeTextFile("/tmp/shared/staging", "replacement");
      const held = await guest.fs.open("/tmp/shared/publish", { read: true, write: true });
      try {
        const before = await held.stat();
        await guest.fs.rename("/tmp/shared/staging", "/tmp/shared/publish");
        assert.equal(await guest.fs.readTextFile("/tmp/shared/publish"), "replacement");
        assert.equal((await held.stat()).ino, before.ino);
        const bytes = new Uint8Array(3);
        assert.equal(await held.read(bytes), 3);
        assert.equal(new TextDecoder().decode(bytes), "old");
        await held.seek(0, SeekMode.Start);
        assert.equal(await held.write(new TextEncoder().encode("OLD")), 3);
        await held.sync();
        assert.equal(await readFile(path.join(shared, "publish"), "utf8"), "replacement");
      } finally {
        await held.close();
      }
    });

    await t.test("unlink and recreate keep the original descriptor separate", async () => {
      await guest.fs.writeTextFile("/tmp/shared/recreated", "original");
      const held = await guest.fs.open("/tmp/shared/recreated", { read: true, write: true });
      try {
        const before = await held.stat();
        await guest.fs.remove("/tmp/shared/recreated");
        await guest.fs.writeTextFile("/tmp/shared/recreated", "new");
        assert.equal((await held.stat()).ino, before.ino);
        assert.equal((await held.stat()).nlink, 0);
        const bytes = new Uint8Array(8);
        assert.equal(await held.read(bytes), 8);
        assert.equal(new TextDecoder().decode(bytes), "original");
        await held.truncate(2);
        await held.sync();
        assert.equal((await held.stat()).size, 2);
        assert.equal(await readFile(path.join(shared, "recreated"), "utf8"), "new");
      } finally {
        await held.close();
      }
    });
  } finally {
    await guest.unmount("/tmp/shared");
  }
});
