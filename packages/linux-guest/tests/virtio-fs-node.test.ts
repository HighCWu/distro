import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
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
  const handle = await fs.open(right, linux_open.readwrite);
  try {
    await fs.rename(fs.root, source, fs.root, destination);
    assert.equal(await fs.lookup(fs.root, source), left);
    assert.equal(await fs.lookup(fs.root, destination), right);
    assert.equal((await fs.getattr(left)).nlink, 2);
    assert.equal((await fs.getattr(right)).nlink, 2);
    await fs.unlink(fs.root, source);
    await assert.rejects(fs.getattr(left), { errno: 2 });
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

  for (const operation of [
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
