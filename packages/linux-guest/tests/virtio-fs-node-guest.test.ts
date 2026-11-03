// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileSystemDevice } from "@lowland/kernel";
import { NodeFS } from "../src/node.ts";
import { SeekMode, SystemError } from "../src/index.ts";
import { guest_test } from "./fixture.ts";
import {
  load_file_timestamps,
  load_open_file_metadata,
  load_file_creation_modes,
  load_readonly_access,
} from "./assets.ts";

guest_test("Node directory sharing through Linux", async (t, fixture) => {
  const shared = await mkdtemp(path.join(tmpdir(), "linux-guest-node-mount-"));
  t.after(() => rm(shared, { recursive: true, force: true }));
  const filesystem = new NodeFS(shared);
  const guest = await fixture.spawn([
    fileSystemDevice(filesystem, { tag: "node-test", cache: false }),
    fileSystemDevice(new NodeFS(shared, { readOnly: true }), {
      tag: "node-readonly",
      cache: false,
    }),
  ]);
  await guest.fs.mkdir("/tmp/shared", { recursive: true });
  await guest.mount("node-test", "/tmp/shared", { type: "virtiofs" });

  try {
    await t.test("standard access probes honor backend read-only policy", async () => {
      await writeFile(path.join(shared, "access-probe"), "readable");
      await guest.fs.mkdir("/tmp/readonly-shared");
      // Deliberately do not set a read-only mount flag: the server's access
      // policy must agree with its open/write policy on this ordinary mount.
      await guest.mount("node-readonly", "/tmp/readonly-shared", { type: "virtiofs" });
      await guest.fs.writeFile("/tmp/readonly-access", await load_readonly_access());
      await guest.fs.chmod("/tmp/readonly-access", 0o755);
      const process = await guest.exec([
        "/tmp/readonly-access",
        "/tmp/readonly-shared/access-probe",
        "/tmp/readonly-shared",
      ]);
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      assert.equal((await process.status).success, true, await stderr);
      assert.deepEqual((await stdout).trim().split("\n"), [
        "readonly access: existence and read probes succeed on the read-only backend pass",
        "readonly access: file, directory, mixed and effective-ID write probes return EROFS pass",
        "readonly access: actual open policy, read recovery and missing-path errors remain correct pass",
      ]);
      assert.equal(await readFile(path.join(shared, "access-probe"), "utf8"), "readable");
    });

    await t.test(
      "leading U+FEFF names and link targets remain distinct through Linux",
      async () => {
        const marked = "\uFEFFbom-victim",
          renamed = "\uFEFFbom-renamed";
        const base = "/tmp/shared/";
        await writeFile(path.join(shared, "bom-victim"), "plain");
        await writeFile(path.join(shared, "bom-renamed"), "sentinel");
        await writeFile(path.join(shared, marked), "marked");
        assert.equal(await guest.fs.readTextFile(base + marked), "marked");
        await guest.fs.symlink(marked, base + "\uFEFFbom-link");
        assert.equal(await guest.fs.readLink(base + "\uFEFFbom-link"), marked);
        assert.equal(await guest.fs.readTextFile(base + "\uFEFFbom-link"), "marked");
        const entries = [];
        for await (const entry of guest.fs.readDir("/tmp/shared")) entries.push(entry.name);
        for (const name of [marked, "bom-victim", "bom-renamed", "\uFEFFbom-link"])
          assert(entries.includes(name));
        await guest.fs.rename(base + marked, base + renamed);
        assert.equal(await readFile(path.join(shared, renamed), "utf8"), "marked");
        assert.equal(await readFile(path.join(shared, "bom-victim"), "utf8"), "plain");
        assert.equal(await readFile(path.join(shared, "bom-renamed"), "utf8"), "sentinel");
        await assert.rejects(
          guest.fs.readTextFile(base + "\uFEFFbom-link"),
          (error) => error instanceof SystemError && error.code === "ENOENT",
        );
        await guest.fs.remove(base + renamed);
        assert.equal(await readFile(path.join(shared, "bom-renamed"), "utf8"), "sentinel");
        await guest.fs.remove(base + "\uFEFFbom-link");
      },
    );

    await t.test("Linux creation umask is not filtered again by the host", async () => {
      await guest.fs.writeFile("/tmp/file-creation-modes", await load_file_creation_modes());
      await guest.fs.chmod("/tmp/file-creation-modes", 0o755);
      const process = await guest.exec(["/tmp/file-creation-modes", "/tmp/shared"]);
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      assert.equal((await process.status).success, true, await stderr);
      assert.deepEqual((await stdout).trim().split("\n"), [
        "creation modes: zero Linux umask retains requested file and directory permissions pass",
        "creation modes: existing O_CREAT preserves mode and exclusive collision changes nothing pass",
        "creation modes: Linux umask still removes requested permissions and cleanup recovers pass",
      ]);
    });

    await t.test(
      "descriptor metadata survives unlink without retargeting a replacement",
      async () => {
        await guest.fs.writeTextFile("/tmp/shared/metadata-file", "old");
        await guest.fs.writeFile("/tmp/open-file-metadata", await load_open_file_metadata());
        await guest.fs.chmod("/tmp/open-file-metadata", 0o755);
        const process = await guest.exec(["/tmp/open-file-metadata", "/tmp/shared/metadata-file"]);
        const stdout = new Response(process.stdout).text();
        const stderr = new Response(process.stderr).text();
        assert.equal((await process.status).success, true, await stderr);
        assert.deepEqual((await stdout).trim().split("\n"), [
          "open metadata: fchmod updates unlinked inode and leaves same-name replacement unchanged pass",
          "open metadata: owner and timestamp operations retain old inode and independent data pass",
          "open metadata: closed descriptor fails and replacement remains usable pass",
        ]);
        assert.equal(await readFile(path.join(shared, "metadata-file"), "utf8"), "new");
      },
    );

    await t.test("standard utimensat and futimens retain signed file timestamps", async () => {
      await guest.fs.writeTextFile("/tmp/shared/timestamp-file", "unchanged");
      await guest.fs.writeFile("/tmp/file-timestamps", await load_file_timestamps());
      await guest.fs.chmod("/tmp/file-timestamps", 0o755);
      const process = await guest.exec(["/tmp/file-timestamps", "/tmp/shared/timestamp-file"]);
      const stdout = new Response(process.stdout).text();
      const stderr = new Response(process.stderr).text();
      assert.equal((await process.status).success, true, await stderr);
      const stages = (await stdout).trim().split("\n");
      assert.deepEqual(stages, [
        "file timestamps: utimensat preserves negative time64 seconds and fractions pass",
        "file timestamps: futimens preserves negative seconds and invalid nanoseconds leave times unchanged pass",
        "file timestamps: UTIME_OMIT retains atime and later positive timestamp recovers pass",
      ]);
    });

    await t.test(
      "host-created hard links have one Linux inode across lookup and readdir",
      async () => {
        await writeFile(path.join(shared, "host-source"), "original");
        await link(path.join(shared, "host-source"), path.join(shared, "host-alias"));
        const source = await guest.fs.stat("/tmp/shared/host-source");
        const alias = await guest.fs.stat("/tmp/shared/host-alias");
        assert.equal(alias.ino, source.ino);
        assert.equal(alias.nlink, 2);
        const held = await guest.fs.open("/tmp/shared/host-source", { read: true, write: true });
        try {
          const process = await guest.exec([
            "sh",
            "-c",
            "test /tmp/shared/host-source -ef /tmp/shared/host-alias && ls -i /tmp/shared/host-source /tmp/shared/host-alias",
          ]);
          const stdout = new Response(process.stdout).text();
          const stderr = new Response(process.stderr).text();
          assert.equal((await process.status).success, true, await stderr);
          const rows = (await stdout)
            .trim()
            .split("\n")
            .map((row) => row.trim().split(/\s+/));
          assert.equal(rows.length, 2);
          assert.equal(rows[0]![0], rows[1]![0]);
          await guest.fs.remove("/tmp/shared/host-source");
          assert.equal((await held.stat()).nlink, 1);
          assert.equal((await guest.fs.stat("/tmp/shared/host-alias")).ino, source.ino);
          await held.seek(0, SeekMode.Start);
          assert.equal(await held.write(new TextEncoder().encode("O")), 1);
          await held.sync();
          assert.equal(await readFile(path.join(shared, "host-alias"), "utf8"), "Original");
        } finally {
          await held.close();
        }
      },
    );

    await t.test(
      "standard ln preserves hard-link inode, alias rename and open lifetime",
      async () => {
        const base = "/tmp/shared";
        await guest.fs.writeTextFile(`${base}/link-source`, "original");
        await guest.fs.mkdir(`${base}/links`);
        const process = await guest.exec(["ln", `${base}/link-source`, `${base}/links/alias`]);
        const stderr = new Response(process.stderr).text();
        const stdout = new Response(process.stdout).text();
        assert.equal((await process.status).success, true, await stderr);
        assert.equal(await stdout, "");
        const before = await guest.fs.stat(`${base}/link-source`);
        const linked = await guest.fs.stat(`${base}/links/alias`);
        assert.equal(linked.ino, before.ino);
        assert.equal(linked.nlink, 2);
        const held = await guest.fs.open(`${base}/link-source`, { read: true, write: true });
        try {
          await guest.fs.remove(`${base}/link-source`);
          await guest.fs.rename(`${base}/links/alias`, `${base}/link-renamed`);
          const renamed = await guest.fs.stat(`${base}/link-renamed`);
          assert.equal(renamed.ino, before.ino);
          assert.equal(renamed.nlink, 1);
          assert.equal(await held.write(new TextEncoder().encode("UPDATED!")), 8);
          await held.sync();
          assert.equal(await readFile(path.join(shared, "link-renamed"), "utf8"), "UPDATED!");
          await guest.fs.remove(`${base}/link-renamed`);
          await guest.fs.writeTextFile(`${base}/link-renamed`, "replacement");
          assert.equal((await held.stat()).ino, before.ino);
          assert.equal((await held.stat()).nlink, 0);
          await held.seek(0, SeekMode.Start);
          const data = new Uint8Array(8);
          assert.equal(await held.read(data), 8);
          assert.equal(new TextDecoder().decode(data), "UPDATED!");
          assert.notEqual((await guest.fs.stat(`${base}/link-renamed`)).ino, before.ino);
        } finally {
          await held.close();
        }
      },
    );

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
