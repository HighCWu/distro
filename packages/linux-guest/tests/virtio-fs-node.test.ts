import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { FSError } from "@lowland/kernel";
import { NodeFS } from "../src/node.ts";

// Virtio-fs carries Linux ABI flags even when this test runs on another host.
const linux_open = {
  readonly: 0,
  writeonly: 1,
  readwrite: 2,
  create: 0x40,
  exclusive: 0x80,
  truncate: 0x200,
  closeOnExec: 0x80000,
  path: 0x200000,
} as const;

const temporary = await mkdtemp(path.join(tmpdir(), "linux-guest-virtio-fs-"));
const shared = path.join(temporary, "shared");
const outside = path.join(temporary, "outside");
await mkdir(shared);
await mkdir(outside);
after(() => rm(temporary, { recursive: true, force: true }));

test("stale parent inode requests never act on a host replacement directory", async () => {
  const context = { mode: 0o100600, uid: process.getuid!(), gid: process.getgid!() };
  for (const operation of [
    "unlink",
    "rmdir",
    "lookup",
    "create",
    "mkdir",
    "symlink",
    "link",
    "rename-source",
    "rename-target",
  ] as const) {
    const directory = await mkdtemp(path.join(temporary, "stale-parent-"));
    const target = path.join(directory, "parent"),
      moved = path.join(directory, "moved");
    await mkdir(target);
    await writeFile(path.join(target, "victim"), "old");
    await writeFile(path.join(directory, "source"), "source");
    const fs = new NodeFS(directory);
    const parent = (await fs.lookup(fs.root, "parent"))!;
    const source = (await fs.lookup(fs.root, "source"))!;
    await rename(target, moved);
    await mkdir(target);
    await mkdir(path.join(target, "empty"));
    await writeFile(path.join(target, "victim"), "replacement");
    await assert.rejects(
      async () => {
        switch (operation) {
          case "unlink":
            return await fs.unlink(parent, "victim");
          case "rmdir":
            return await fs.rmdir(parent, "empty");
          case "lookup":
            return await fs.lookup(parent, "victim");
          case "create": {
            const opened = await fs.create(
              parent,
              "victim",
              linux_open.writeonly | linux_open.truncate,
              context,
            );
            await fs.release(opened.node, opened.handle);
            return;
          }
          case "mkdir":
            return await fs.mkdir(parent, "created", { ...context, mode: 0o40700 });
          case "symlink":
            return await fs.symlink(parent, "created", "victim", context);
          case "link":
            return await fs.link(source, parent, "created");
          case "rename-source":
            return await fs.rename(parent, "victim", fs.root, "destination");
          case "rename-target":
            return await fs.rename(fs.root, "source", parent, "victim");
        }
      },
      { errno: 2 },
      operation,
    );
    assert.equal(await readFile(path.join(target, "victim"), "utf8"), "replacement", operation);
    assert.equal(await readFile(path.join(moved, "victim"), "utf8"), "old", operation);
    assert.equal(await readFile(path.join(directory, "source"), "utf8"), "source", operation);
    assert.equal((await stat(path.join(target, "empty"))).isDirectory(), true, operation);
    await assert.rejects(lstat(path.join(target, "created")), { code: "ENOENT" });
    const fresh = (await fs.lookup(fs.root, "parent"))!;
    assert.notEqual(fresh, parent);
    const child = (await fs.lookup(fresh, "victim"))!;
    const held = await fs.open(child, linux_open.readonly);
    try {
      assert.equal(new TextDecoder().decode(await fs.read(child, held, 0n, 11)), "replacement");
    } finally {
      await fs.release(child, held);
    }
  }
});

test("node hard links keep aliases, rename and the last open inode coherent", async () => {
  const directory = await mkdtemp(path.join(temporary, "hard-links-"));
  await writeFile(path.join(directory, "source"), "original");
  await mkdir(path.join(directory, "sub"));
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "source"))!;
  const sub = (await fs.lookup(fs.root, "sub"))!;
  const held = await fs.open(node, linux_open.readwrite);
  try {
    await fs.link(node, sub, "alias");
    assert.equal(await fs.lookup(sub, "alias"), node);
    assert.equal((await fs.getattr(node)).nlink, 2);
    assert.equal(
      (await lstat(path.join(directory, "source"))).ino,
      (await lstat(path.join(directory, "sub/alias"))).ino,
    );
    await assert.rejects(fs.link(node, sub, "alias"), { errno: 17 });
    await assert.rejects(fs.link(sub, fs.root, "directory-link"), { errno: 1 });
    await fs.unlink(fs.root, "source");
    assert.equal((await fs.getattr(node)).nlink, 1);
    await fs.rename(sub, "alias", fs.root, "renamed");
    assert.equal(await fs.lookup(fs.root, "renamed"), node);
    await fs.write(node, held, 0n, new TextEncoder().encode("UPDATED!"));
    assert.equal(await readFile(path.join(directory, "renamed"), "utf8"), "UPDATED!");
    await fs.unlink(fs.root, "renamed");
    await writeFile(path.join(directory, "renamed"), "replacement");
    assert.equal((await fs.getattr(node)).nlink, 0);
    assert.equal(new TextDecoder().decode(await fs.read(node, held, 0n, 8)), "UPDATED!");
    assert.notEqual(await fs.lookup(fs.root, "renamed"), node);
  } finally {
    await fs.release(node, held);
  }
  const ro = new NodeFS(directory, { readOnly: true });
  const readonlyNode = (await ro.lookup(ro.root, "renamed"))!;
  await assert.rejects(ro.link(readonlyNode, ro.root, "denied"), { errno: 30 });
  await assert.rejects(fs.link(readonlyNode, fs.root, "foreign"), { errno: 22 });
});

test("node hard links preserve symlink identity without following its target", async () => {
  const directory = await mkdtemp(path.join(temporary, "hard-symlinks-"));
  await symlink("missing", path.join(directory, "source"));
  const fs = new NodeFS(directory);
  const source = (await fs.lookup(fs.root, "source"))!;
  await fs.link(source, fs.root, "alias");
  assert.equal(await fs.lookup(fs.root, "alias"), source);
  await fs.unlink(fs.root, "source");
  assert.equal(await fs.readlink(source), "missing");
  assert.equal((await fs.getattr(source)).nlink, 1);
});

test("host aliases discovered after unlink retain the open inode and enumeration identity", async () => {
  const directory = await mkdtemp(path.join(temporary, "discovered-links-"));
  await writeFile(path.join(directory, "source"), "original");
  await link(path.join(directory, "source"), path.join(directory, "alias"));
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "source"))!;
  const handle = await fs.open(node, linux_open.readwrite);
  try {
    await fs.unlink(fs.root, "source");
    assert.equal((await fs.getattr(node)).nlink, 1);
    const alias = await fs.lookup(fs.root, "alias");
    assert.equal(
      alias,
      node,
      "an open inode is still the same object when another name is discovered",
    );
    const dir = await fs.opendir(fs.root);
    try {
      const entries = await fs.readdir(fs.root, dir);
      assert.equal(entries.find(({ name }) => name === "alias")?.node, node);
    } finally {
      await fs.releasedir(fs.root, dir);
    }
    await fs.write(node, handle, 0n, new TextEncoder().encode("O"));
    assert.equal(await readFile(path.join(directory, "alias"), "utf8"), "Original");
    await fs.unlink(fs.root, "alias");
    await writeFile(path.join(directory, "alias"), "new");
    assert.notEqual(await fs.lookup(fs.root, "alias"), node);
    assert.equal((await fs.getattr(node)).nlink, 0);
  } finally {
    await fs.release(node, handle);
  }
});

test("host replacement of a cached pathname does not rebind an open old inode", async () => {
  const directory = await mkdtemp(path.join(temporary, "replaced-host-inode-"));
  await writeFile(path.join(directory, "file"), "old");
  await writeFile(path.join(directory, "staging"), "new");
  await chmod(path.join(directory, "staging"), 0o640);
  const fs = new NodeFS(directory);
  const old = (await fs.lookup(fs.root, "file"))!;
  const handle = await fs.open(old, linux_open.readonly);
  try {
    await rename(path.join(directory, "staging"), path.join(directory, "file"));
    // No lookup of the replaced name may be needed to preserve the old fd.
    assert.equal((await fs.getattr(old)).nlink, 0);
    await fs.setattr(old, { mode: 0o600 });
    assert.equal((await fs.getattr(old)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(directory, "file"))).mode & 0o777, 0o640);
    assert.notEqual(await fs.lookup(fs.root, "file"), old);
    assert.equal(new TextDecoder().decode(await fs.read(old, handle, 0n, 3)), "old");
  } finally {
    await fs.release(old, handle);
  }
});

test("stale inode paths reject completed host replacement before destructive operations", async () => {
  for (const operation of [
    "open",
    "truncate",
    "getattr",
    "chmod",
    "resize",
    "access",
    "readlink",
  ]) {
    const directory = await mkdtemp(path.join(temporary, "stale-path-"));
    const target = path.join(directory, "file"),
      staging = path.join(directory, "staging");
    if (operation === "readlink") {
      await symlink("old-target", target);
      await symlink("new-target", staging);
    } else {
      await writeFile(target, "old");
      await writeFile(staging, "replacement");
    }
    const fs = new NodeFS(directory);
    const old = (await fs.lookup(fs.root, "file"))!;
    await rename(staging, target);
    const before = await lstat(target);
    await assert.rejects(
      async () => {
        switch (operation) {
          case "open":
          case "truncate": {
            const handle = await fs.open(
              old,
              operation === "open"
                ? linux_open.readonly
                : linux_open.writeonly | linux_open.truncate,
            );
            await fs.release(old, handle);
            break;
          }
          case "getattr":
            await fs.getattr(old);
            break;
          case "chmod":
            await fs.setattr(old, { mode: 0o600 });
            break;
          case "resize":
            await fs.setattr(old, { size: 0n });
            break;
          case "access":
            await fs.access(old, constants.R_OK);
            break;
          case "readlink":
            await fs.readlink(old);
            break;
        }
      },
      (error) => error instanceof FSError && error.errno === 2,
      operation,
    );
    const after = await lstat(target);
    assert.deepEqual([after.ino, after.mode, after.size], [before.ino, before.mode, before.size]);
    const fresh = (await fs.lookup(fs.root, "file"))!;
    assert.notEqual(fresh, old);
    if (operation === "readlink") {
      assert.equal(await fs.readlink(fresh), "new-target");
    } else {
      assert.equal(await readFile(target, "utf8"), "replacement");
      const handle = await fs.open(fresh, linux_open.readonly);
      try {
        assert.equal(new TextDecoder().decode(await fs.read(fresh, handle, 0n, 11)), "replacement");
      } finally {
        await fs.release(fresh, handle);
      }
    }
  }
});

test("stale selected hard-link alias falls back to another known alias of the same inode", async () => {
  const directory = await mkdtemp(path.join(temporary, "stale-hard-link-"));
  await writeFile(path.join(directory, "source"), "old");
  await link(path.join(directory, "source"), path.join(directory, "alias"));
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "source"))!;
  assert.equal(await fs.lookup(fs.root, "alias"), node);
  await writeFile(path.join(directory, "staging"), "replacement");
  await rename(path.join(directory, "staging"), path.join(directory, "alias"));
  const handle = await fs.open(node, linux_open.readonly);
  try {
    assert.equal(new TextDecoder().decode(await fs.read(node, handle, 0n, 3)), "old");
  } finally {
    await fs.release(node, handle);
  }
  assert.equal(await fs.lookup(fs.root, "source"), node);
  assert.notEqual(await fs.lookup(fs.root, "alias"), node);
  assert.equal(await readFile(path.join(directory, "alias"), "utf8"), "replacement");
});

test("verified regular-file truncation preserves read-only logical access and normal writes", async () => {
  const directory = await mkdtemp(path.join(temporary, "verified-truncate-"));
  await writeFile(path.join(directory, "file"), "original");
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "file"))!;
  const readonly = await fs.open(node, linux_open.readonly | linux_open.truncate);
  try {
    assert.equal((await fs.getattr(node)).size, 0n);
    assert.equal((await fs.read(node, readonly, 0n, 8)).length, 0);
    await assert.rejects(fs.write(node, readonly, 0n, new Uint8Array([1])), { errno: 9 });
    await assert.rejects(fs.setattr(node, { size: 8n }, readonly), { errno: 22 });
  } finally {
    await fs.release(node, readonly);
  }
  const writable = await fs.open(node, linux_open.writeonly | linux_open.truncate);
  try {
    assert.equal(await fs.write(node, writable, 0n, new TextEncoder().encode("new")), 3);
  } finally {
    await fs.release(node, writable);
  }
  assert.equal(await readFile(path.join(directory, "file"), "utf8"), "new");
});

test("path truncation works while an existing read-only descriptor keeps its inode open", async () => {
  const directory = await mkdtemp(path.join(temporary, "path-truncate-readonly-"));
  await writeFile(path.join(directory, "file"), "original");
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "file"))!;
  const readonly = await fs.open(node, linux_open.readonly);
  try {
    await fs.setattr(node, { size: 3n });
    assert.equal((await fs.getattr(node)).size, 3n);
    assert.equal(new TextDecoder().decode(await fs.read(node, readonly, 0n, 8)), "ori");
    await assert.rejects(fs.setattr(node, { size: 0n }, readonly), { errno: 22 });
    assert.equal(await readFile(path.join(directory, "file"), "utf8"), "ori");
  } finally {
    await fs.release(node, readonly);
  }
});

test("inode SETATTR without FH changes only the unlinked open file", async () => {
  const directory = await mkdtemp(path.join(temporary, "unlinked-setattr-"));
  await writeFile(path.join(directory, "file"), "old");
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "file"))!;
  const held = await fs.open(node, linux_open.readonly);
  try {
    const before = await fs.getattr(node);
    await fs.unlink(fs.root, "file");
    await writeFile(path.join(directory, "file"), "new", { mode: 0o644 });
    const replacement = (await fs.lookup(fs.root, "file"))!;
    const replacementBefore = await fs.getattr(replacement);
    await fs.setattr(node, { mode: 0o600 });
    await fs.setattr(node, { uid: before.uid!, gid: before.gid! });
    assert.equal((await fs.getattr(node)).mode & 0o777, 0o600);
    assert.equal((await fs.getattr(node)).nlink, 0);
    assert.equal((await fs.getattr(replacement)).mode, replacementBefore.mode);
    assert.equal(await readFile(path.join(directory, "file"), "utf8"), "new");
    assert.equal(new TextDecoder().decode(await fs.read(node, held, 0n, 3)), "old");
    const other = new NodeFS(directory);
    await assert.rejects(other.setattr(node, { mode: 0o777 }), { errno: 22 });
  } finally {
    await fs.release(node, held);
  }
  await assert.rejects(fs.setattr(node, { mode: 0o777 }), { errno: 2 });
});

test(
  "creation mode uses the Linux caller's mask without modifying host umask",
  { concurrency: false },
  async () => {
    const directory = await mkdtemp(path.join(temporary, "creation-mask-"));
    const fs = new NodeFS(directory);
    // This test runner is isolated. Production NodeFS must never change this
    // process-global value; a restrictive host mask exposes double filtering.
    const original = process.umask(0o077);
    const context = { mode: 0o666, uid: 0, gid: 0 };
    try {
      const made = await fs.create(
        fs.root,
        "file",
        linux_open.readwrite | linux_open.exclusive,
        context,
      );
      try {
        assert.equal((await fs.getattr(made.node)).mode & 0o777, 0o666);
      } finally {
        await fs.release(made.node, made.handle);
      }
      const child = await fs.mkdir(fs.root, "directory", { ...context, mode: 0o777 });
      assert.equal((await fs.getattr(child)).mode & 0o777, 0o777);
      if (process.platform === "linux") {
        await fs.setattr(child, { mode: 0o2770 });
        const nested = await fs.mkdir(child, "nested", { ...context, mode: 0o777 });
        assert.equal((await fs.getattr(nested)).mode & 0o2777, 0o2777, "retain inherited setgid");
      }
      await fs.setattr(made.node, { mode: 0o640 });
      const existing = await fs.create(
        fs.root,
        "file",
        linux_open.readwrite | linux_open.truncate,
        { ...context, mode: 0o777 },
      );
      try {
        assert.equal((await fs.getattr(existing.node)).mode & 0o777, 0o640);
      } finally {
        await fs.release(existing.node, existing.handle);
      }
      await assert.rejects(
        fs.create(fs.root, "file", linux_open.readwrite | linux_open.exclusive, context),
        { errno: 17 },
      );
      assert.equal((await fs.getattr(made.node)).mode & 0o777, 0o640);
      assert.equal(process.umask(), 0o077);
    } finally {
      process.umask(original);
    }
  },
);

test("node virtio-fs directory entries preserve file, directory and symlink kinds", async () => {
  const directory = await mkdtemp(path.join(temporary, "entry-types-"));
  await writeFile(path.join(directory, "file"), "data");
  await mkdir(path.join(directory, "directory"));
  await symlink("file", path.join(directory, "link"));
  await symlink("missing", path.join(directory, "dangling"));
  const fs = new NodeFS(directory);
  const handle = await fs.opendir(fs.root);
  try {
    const entries = await fs.readdir(fs.root, handle);
    assert.deepEqual(entries.map(({ name, type }) => [name, type]).sort(), [
      ["dangling", "symlink"],
      ["directory", "directory"],
      ["file", "file"],
      ["link", "symlink"],
    ]);
  } finally {
    await fs.releasedir(fs.root, handle);
  }
});

test("node virtio-fs synchronizes and closes an opened directory after unlink", async () => {
  const directory = await mkdtemp(path.join(temporary, "sync-dir-"));
  await mkdir(path.join(directory, "child"));
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "child"))!;
  const handle = await fs.opendir(node);
  let released = false;
  try {
    assert.ok(handle.file, "supported hosts must retain the opened directory descriptor");
    const file = handle.file;
    const ino = (await file.stat({ bigint: true })).ino;
    const sync = file.sync.bind(file);
    let syncs = 0;
    file.sync = async () => {
      syncs++;
      await sync();
    };
    await fs.fsync(node, handle, false);
    await fs.fsync(node, handle, true);
    assert.equal(syncs, 2, "both directory synchronization hints use fsync");
    file.sync = async () => {
      throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
    };
    await assert.rejects(fs.fsync(node, handle, false), { errno: 5 });
    file.sync = sync;
    await fs.rmdir(fs.root, "child");
    await fs.fsync(node, handle, false);
    assert.equal((await fs.getattr(node)).mode & 0o170000, 0o040000);
    assert.equal((await file.stat({ bigint: true })).ino, ino);
    await fs.releasedir(node, handle);
    released = true;
    await assert.rejects(fs.readdir(node, handle), { errno: 9 });
    await assert.rejects(fs.fsync(node, handle, false), { errno: 9 });
    await assert.rejects(fs.releasedir(node, handle), { errno: 9 });
    await assert.rejects(file.stat(), { code: "EBADF" });
    await assert.rejects(fs.getattr(node), { errno: 2 });
  } finally {
    if (!released && handle.file) await fs.releasedir(node, handle);
  }
});

for (const closeFails of [false, true]) {
  test(`node virtio-fs rejects directory reads queued behind release, close fails=${closeFails}`, async () => {
    const fs = new NodeFS(shared);
    const handle = await fs.opendir(fs.root);
    assert.ok(handle.file);
    const close = handle.file.close.bind(handle.file);
    handle.file.close = async () => {
      await close();
      if (closeFails) throw Object.assign(new Error("injected close failure"), { code: "EIO" });
    };
    // release queues its close, but has not started it when readdir is called.
    // The queued read must recheck ownership/liveness at execution time.
    const releasing = fs.releasedir(fs.root, handle);
    const reading = fs.readdir(fs.root, handle);
    await Promise.all([
      closeFails ? assert.rejects(releasing, { errno: 5 }) : releasing,
      assert.rejects(reading, { errno: 9 }),
    ]);
    await assert.rejects(handle.file.stat(), { code: "EBADF" });
    const replacement = await fs.opendir(fs.root);
    try {
      assert.ok(
        Array.isArray(await fs.readdir(fs.root, replacement)),
        "the path queue remains usable",
      );
    } finally {
      await fs.releasedir(fs.root, replacement);
    }
  });
}

test("node virtio-fs preserves sub-millisecond and pre-epoch timestamps", async () => {
  const fs = new NodeFS(shared);
  const { node, handle } = await fs.create(fs.root, "timestamp-check", linux_open.readwrite, {
    mode: 0o100600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  const near = (actual: bigint, expected: bigint) => {
    const difference = actual > expected ? actual - expected : expected - actual;
    assert.ok(difference <= 1000n, `timestamp differs by ${difference}ns`);
  };
  try {
    await fs.setattr(
      node,
      {
        atime: { seconds: 1n, nanoseconds: 123456000 },
        mtime: { seconds: 2n, nanoseconds: 987654000 },
      },
      handle,
    );
    const before = await handle.file!.stat({ bigint: true });
    near(before.atimeNs, 1123456000n);
    near(before.mtimeNs, 2987654000n);
    await fs.setattr(node, { mtime: { seconds: 3n, nanoseconds: 987654000 } });
    const after = await handle.file!.stat({ bigint: true });
    near(after.atimeNs, before.atimeNs);
    near(after.mtimeNs, 3987654000n);

    for (const timestamp of [
      { seconds: 0n, nanoseconds: -1 },
      { seconds: 0n, nanoseconds: 1_000_000_000 },
      { seconds: 0n, nanoseconds: 0.5 },
      { seconds: 0n, nanoseconds: NaN },
      { seconds: 0n, nanoseconds: Infinity },
      { seconds: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
    ]) {
      await assert.rejects(fs.setattr(node, { size: 99n, mtime: timestamp }, handle), {
        errno: 22,
      });
    }
    const unchanged = await handle.file!.stat({ bigint: true });
    assert.equal(unchanged.size, 0n, "invalid timestamps must be rejected before truncation");
    assert.equal(unchanged.mtimeNs, after.mtimeNs);

    await fs.setattr(
      node,
      {
        atime: { seconds: -1n, nanoseconds: 250000000 },
        mtime: { seconds: -1n, nanoseconds: 500000000 },
      },
      handle,
    );
    for (const attrs of [await fs.getattr(node), await fs.getattr(node, handle)]) {
      assert.deepEqual(attrs.atime, { seconds: -1n, nanoseconds: 250000000 });
      assert.deepEqual(attrs.mtime, { seconds: -1n, nanoseconds: 500000000 });
    }
  } finally {
    await fs.release(node, handle);
  }
});

test("node virtio-fs rejects invalid ranges before allocating or issuing I/O", async () => {
  const fs = new NodeFS(shared);
  const { node, handle } = await fs.create(fs.root, "range-check", linux_open.readwrite, {
    mode: 0o100600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    await fs.write(node, handle, 0n, new TextEncoder().encode("original"));
    let reads = 0,
      writes = 0;
    const file = handle.file!;
    const read = file.read;
    const write = file.write;
    file.read = (...args: unknown[]) => {
      reads++;
      return Reflect.apply(read, file, args);
    };
    file.write = (...args: unknown[]) => {
      writes++;
      return Reflect.apply(write, file, args);
    };
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
      await assert.rejects(fs.write(node, handle, offset, Uint8Array.of(42)), { errno: 22 });
    }
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(new TextDecoder().decode(await fs.read(node, handle, 1n, 3)), "rig");
    assert.equal((await fs.read(node, handle, 100n, 3)).byteLength, 0);
    assert.equal((await fs.read(node, handle, 0n, 0)).byteLength, 0);
    assert.equal(await fs.write(node, handle, 0n, Uint8Array.of(79)), 1);
    assert.equal(new TextDecoder().decode(await fs.read(node, handle, 0n, 8)), "Original");
  } finally {
    await fs.release(node, handle);
  }
});

test("node virtio-fs binds nodes and handles to their adapter and file", async () => {
  const left = new NodeFS(shared);
  const right = new NodeFS(outside);
  const context = { mode: 0o100600, uid: process.getuid!(), gid: process.getgid!() };
  const a = await left.create(left.root, "owner-a", linux_open.readwrite, context);
  const sibling = await left.create(left.root, "owner-sibling", linux_open.readwrite, context);
  const b = await right.create(right.root, "owner-b", linux_open.readwrite, context);
  try {
    await left.write(a.node, a.handle, 0n, new TextEncoder().encode("left"));
    await right.write(b.node, b.handle, 0n, new TextEncoder().encode("right"));
    await assert.rejects(left.lookup(right.root, "owner-b"), { errno: 22 });
    await assert.rejects(left.getattr(b.node), { errno: 22 });
    await assert.rejects(left.open(b.node, linux_open.readonly), { errno: 22 });
    for (const [node, handle, errno] of [
      [a.node, b.handle, 9],
      [b.node, b.handle, 22],
      [a.node, sibling.handle, 9],
    ] as const) {
      for (const operation of [
        () => left.getattr(node, handle),
        () => left.setattr(node, { size: 0n }, handle),
        () => left.read(node, handle, 0n, 5),
        () => left.write(node, handle, 0n, Uint8Array.of(42)),
        () => left.flush(node, handle),
        () => left.fsync(node, handle, false),
        () => left.release(node, handle),
      ]) {
        await assert.rejects(operation(), { errno });
      }
    }
    const directory = await right.opendir(right.root);
    try {
      await assert.rejects(left.readdir(left.root, directory), { errno: 9 });
      await assert.rejects(left.readdir(right.root, directory), { errno: 22 });
      await assert.rejects(left.releasedir(left.root, directory), { errno: 9 });
      await assert.rejects(left.fsync(left.root, directory, false), { errno: 9 });
    } finally {
      await right.releasedir(right.root, directory);
    }
    assert.equal(new TextDecoder().decode(await left.read(a.node, a.handle, 0n, 5)), "left");
    assert.equal(new TextDecoder().decode(await right.read(b.node, b.handle, 0n, 5)), "right");
    assert.equal((await left.getattr(sibling.node, sibling.handle)).size, 0n);
  } finally {
    await left.release(a.node, a.handle);
    await left.release(sibling.node, sibling.handle);
    await right.release(b.node, b.handle);
  }
});

test("node virtio-fs adapter reads and writes beneath its root", async () => {
  const filesystem = new NodeFS(shared);
  const created = await filesystem.create!(
    filesystem.root,
    "hello",
    linux_open.readwrite | linux_open.create | linux_open.exclusive,
    { mode: 0o100640, uid: process.getuid!(), gid: process.getgid!() },
  );
  assert.equal(
    await filesystem.write!(created.node, created.handle, 0n, new TextEncoder().encode("hello")),
    5,
  );
  assert.equal(
    new TextDecoder().decode(await filesystem.read!(created.node, created.handle, 0n, 5)),
    "hello",
  );
  await filesystem.release!(created.node, created.handle);
  assert.equal(await readFile(path.join(shared, "hello"), "utf8"), "hello");
  assert.equal((await filesystem.getattr(created.node)).mode & 0o777, 0o640);
});

test("node virtio-fs adapter rejects adversarial path components", async () => {
  const filesystem = new NodeFS(shared);
  for (const name of ["", ".", "..", "../outside", "/absolute", "nul\0byte"]) {
    await assert.rejects(
      async () => filesystem.lookup(filesystem.root, name),
      (error) => error instanceof FSError && [13, 22].includes(error.errno),
      name,
    );
  }
});

test("node virtio-fs adapter exposes a final symlink without following it", async () => {
  await writeFile(path.join(outside, "secret"), "outside");
  await symlink(path.join(outside, "secret"), path.join(shared, "escape"));
  const filesystem = new NodeFS(shared);
  const escaped = await filesystem.lookup(filesystem.root, "escape");
  assert(escaped);
  assert.equal((await filesystem.getattr(escaped)).mode & constants.S_IFMT, constants.S_IFLNK);
  assert.equal(await filesystem.readlink!(escaped), path.join(outside, "secret"));
});

test("node virtio-fs adapter never follows a final symlink for metadata operations", async () => {
  const target = path.join(outside, "metadata-target");
  const link = path.join(shared, "metadata-escape");
  await writeFile(target, "outside", { mode: 0o640 });
  await symlink(target, link);
  const before = await stat(target);
  const filesystem = new NodeFS(shared);
  const escaped = await filesystem.lookup(filesystem.root, "metadata-escape");
  assert(escaped);

  await assert.rejects(
    filesystem.setattr!(escaped, { mode: 0o600 }),
    (error) => error instanceof FSError && error.errno === 95,
  );
  await filesystem.setattr!(escaped, {
    atime: { seconds: 1n },
    mtime: { seconds: 1n },
  });
  await assert.rejects(
    filesystem.access!(escaped, constants.R_OK),
    (error) => error instanceof FSError && error.errno === 40,
  );

  const after = await stat(target);
  assert.equal(after.mode, before.mode);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await lstat(link)).mtimeMs, 1000);
});

test("node virtio-fs adapter keeps open files distinct across unlink and recreate", async () => {
  const filesystem = new NodeFS(shared);
  const old = await filesystem.create!(filesystem.root, "recreated", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  await filesystem.write!(old.node, old.handle, 0n, new TextEncoder().encode("old"));
  await filesystem.unlink!(filesystem.root, "recreated");
  const replacement = await filesystem.create!(filesystem.root, "recreated", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  await filesystem.write!(
    replacement.node,
    replacement.handle,
    0n,
    new TextEncoder().encode("new"),
  );

  assert.equal((await filesystem.getattr(old.node, old.handle)).size, 3n);
  assert.equal(
    new TextDecoder().decode(await filesystem.read!(old.node, old.handle, 0n, 3)),
    "old",
  );
  // Linux FUSE getattr can omit FH even for fstat on an open, unlinked inode.
  assert.equal((await filesystem.getattr(old.node)).size, 3n);
  assert.equal((await filesystem.getattr(old.node)).nlink, 0);
  await assert.rejects(
    filesystem.open!(old.node, linux_open.readonly),
    (error) => error instanceof FSError && error.errno === 2,
  );
  await filesystem.setattr!(old.node, { size: 2n }, old.handle);
  assert.equal(new TextDecoder().decode(await filesystem.read!(old.node, old.handle, 0n, 3)), "ol");
  assert.equal(await readFile(path.join(shared, "recreated"), "utf8"), "new");
  await filesystem.release!(old.node, old.handle);
  await assert.rejects(filesystem.getattr(old.node), { errno: 2 });
  await filesystem.release!(replacement.node, replacement.handle);
});

test("node virtio-fs detached attributes survive until the last descriptor closes", async () => {
  const fs = new NodeFS(shared);
  const target = await fs.create(fs.root, "held-target", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  const second = await fs.open(target.node, linux_open.readonly);
  const source = await fs.create(fs.root, "held-source", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    await fs.write(target.node, target.handle, 0n, new TextEncoder().encode("old inode"));
    await fs.write(source.node, source.handle, 0n, new TextEncoder().encode("new"));
    await fs.rename(fs.root, "held-source", fs.root, "held-target");
    assert.equal((await fs.getattr(target.node)).size, 9n);
    assert.equal((await fs.getattr(target.node)).nlink, 0);
    assert.equal((await fs.getattr(source.node)).size, 3n);
    await fs.release(target.node, target.handle);
    assert.equal((await fs.getattr(target.node)).size, 9n);
    await assert.rejects(fs.open(target.node, linux_open.readonly), { errno: 2 });
  } finally {
    if (target.handle.file!.fd !== -1) await fs.release(target.node, target.handle);
    await fs.release(target.node, second);
    await fs.release(source.node, source.handle);
  }
  await assert.rejects(fs.getattr(target.node), { errno: 2 });
});

test("node virtio-fs adapter preserves inode generations across replacement rename", async () => {
  const filesystem = new NodeFS(shared);
  const source = await filesystem.create!(filesystem.root, "rename-source", linux_open.readwrite, {
    mode: constants.S_IFREG | 0o600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  const destination = await filesystem.create!(
    filesystem.root,
    "rename-destination",
    linux_open.readwrite,
    {
      mode: constants.S_IFREG | 0o600,
      uid: process.getuid!(),
      gid: process.getgid!(),
    },
  );
  await filesystem.write!(source.node, source.handle, 0n, new TextEncoder().encode("source"));
  await filesystem.release!(source.node, source.handle);
  await filesystem.release!(destination.node, destination.handle);

  await filesystem.rename!(filesystem.root, "rename-source", filesystem.root, "rename-destination");

  assert.equal(await filesystem.lookup(filesystem.root, "rename-destination"), source.node);
  assert.equal((await filesystem.getattr(source.node)).size, 6n);
  await assert.rejects(
    filesystem.getattr(destination.node),
    (error) => error instanceof FSError && error.errno === 2,
  );
});

test("node virtio-fs self rename still validates the source and parent", async () => {
  const fs = new NodeFS(shared);
  await assert.rejects(fs.rename(fs.root, "missing-self", fs.root, "missing-self"), { errno: 2 });
  await writeFile(path.join(shared, "self-file-parent"), "file");
  const parent = await fs.lookup(fs.root, "self-file-parent");
  assert(parent);
  await assert.rejects(fs.rename(parent, "child", parent, "child"), { errno: 20 });

  await symlink(outside, path.join(shared, "self-escape"));
  const escaped = await fs.lookup(fs.root, "self-escape");
  assert(escaped);
  await assert.rejects(fs.rename(escaped, "secret", escaped, "secret"), { errno: 13 });
});

test("node virtio-fs self rename retains existing file and directory identities", async () => {
  const fs = new NodeFS(shared);
  await writeFile(path.join(shared, "self-existing"), "unchanged");
  await mkdir(path.join(shared, "self-directory"));
  await writeFile(path.join(shared, "self-directory", "child"), "child");
  for (const name of ["self-existing", "self-directory"]) {
    const node = await fs.lookup(fs.root, name);
    assert(node);
    const before = await fs.getattr(node);
    const child = name === "self-directory" ? await fs.lookup(node, "child") : undefined;
    await fs.rename(fs.root, name, fs.root, name);
    assert.equal(await fs.lookup(fs.root, name), node);
    assert.deepEqual(await fs.getattr(node), before);
    if (child) assert.equal(await fs.lookup(node, "child"), child);
  }
});

test("node virtio-fs hard-link rename keeps both names and cached nodes attached", async () => {
  const fs = new NodeFS(shared);
  const source = "hardlink-source";
  const destination = "hardlink-destination";
  await writeFile(path.join(shared, source), "original");
  await link(path.join(shared, source), path.join(shared, destination));
  const left = await fs.lookup(fs.root, source);
  const right = await fs.lookup(fs.root, destination);
  assert(left && right);
  assert.equal(left, right, "host-created hard links share the same backend inode");
  const handle = await fs.open(right, linux_open.readwrite);
  try {
    await fs.rename(fs.root, source, fs.root, destination);
    assert.equal(await fs.lookup(fs.root, source), left);
    assert.equal(await fs.lookup(fs.root, destination), right);
    assert.equal((await fs.getattr(left)).nlink, 2);
    assert.equal((await fs.getattr(right)).nlink, 2);
    await fs.unlink(fs.root, source);
    assert.equal((await fs.getattr(left)).nlink, 1);
    assert.equal((await fs.getattr(right)).nlink, 1);
    assert.equal(await fs.write(right, handle, 0n, new TextEncoder().encode("O")), 1);
    assert.equal(await readFile(path.join(shared, destination), "utf8"), "Original");
  } finally {
    await fs.release(right, handle);
  }
});

test("node virtio-fs rename compares symlink inodes, not their shared targets", async () => {
  const fs = new NodeFS(shared);
  await writeFile(path.join(shared, "same-link-target"), "target");
  await symlink("same-link-target", path.join(shared, "same-link-source"));
  await symlink("same-link-target", path.join(shared, "same-link-destination"));
  const source = await fs.lookup(fs.root, "same-link-source");
  const destination = await fs.lookup(fs.root, "same-link-destination");
  assert(source && destination);
  await fs.rename(fs.root, "same-link-source", fs.root, "same-link-destination");
  assert.equal(await fs.lookup(fs.root, "same-link-source"), undefined);
  assert.equal(await fs.lookup(fs.root, "same-link-destination"), source);
  await assert.rejects(fs.getattr(destination), { errno: 2 });
  assert.equal(await fs.readlink(source), "same-link-target");
  assert.equal(await readFile(path.join(shared, "same-link-target"), "utf8"), "target");
});

test("node virtio-fs adapter enforces read-only shares in the backend", async () => {
  const name = "read-only-source";
  await writeFile(path.join(shared, name), "readable");
  const filesystem = new NodeFS(shared, { readOnly: true });
  const node = await filesystem.lookup(filesystem.root, name);
  assert(node);
  const handle = await filesystem.open!(node, linux_open.readonly | linux_open.closeOnExec);
  assert.equal(new TextDecoder().decode(await filesystem.read!(node, handle, 0n, 8)), "readable");
  await filesystem.access(node, constants.F_OK);
  await filesystem.access(node, constants.R_OK);

  for (const operation of [
    () => filesystem.access(node, constants.W_OK),
    () => filesystem.access(node, constants.R_OK | constants.W_OK),
    () => filesystem.access(filesystem.root, constants.W_OK),
    () => filesystem.open!(node, linux_open.writeonly),
    () => filesystem.open!(node, linux_open.readonly | linux_open.truncate),
    () => filesystem.write!(node, handle, 0n, new Uint8Array([1])),
    () => filesystem.setattr!(node, { mode: 0o600 }),
    () =>
      filesystem.create!(filesystem.root, "read-only-created", linux_open.readwrite, {
        mode: constants.S_IFREG | 0o600,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    () =>
      filesystem.mkdir!(filesystem.root, "read-only-directory", {
        mode: constants.S_IFDIR | 0o700,
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    () => filesystem.unlink!(filesystem.root, name),
  ]) {
    await assert.rejects(operation, (error) => error instanceof FSError && error.errno === 30);
  }
  await filesystem.release!(node, handle);
  assert.equal(await readFile(path.join(shared, name), "utf8"), "readable");
});

test("node virtio-fs adapter rejects Linux open modes it cannot implement", async () => {
  const filesystem = new NodeFS(shared);
  const node = await filesystem.lookup(filesystem.root, "hello");
  assert(node);
  await assert.rejects(
    filesystem.open!(node, linux_open.readonly | linux_open.path),
    (error) => error instanceof FSError && error.errno === 95,
  );
});

test("node virtio-fs adapter creates symbolic links", async () => {
  const filesystem = new NodeFS(shared);
  const linked = await filesystem.symlink!(filesystem.root, "hello-link", "hello", {
    mode: constants.S_IFLNK | 0o777,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  assert.equal(await filesystem.readlink!(linked), "hello");
});

test("node virtio-fs adapter detects an ancestor replaced by a symlink", async () => {
  await mkdir(path.join(shared, "safe"));
  const filesystem = new NodeFS(shared);
  const safe = await filesystem.lookup(filesystem.root, "safe");
  assert(safe);

  await rename(path.join(shared, "safe"), path.join(shared, "moved"));
  await symlink(outside, path.join(shared, "safe"));
  await assert.rejects(
    async () => filesystem.lookup(safe, "secret"),
    (error) => error instanceof FSError && error.errno === 13,
  );
});
