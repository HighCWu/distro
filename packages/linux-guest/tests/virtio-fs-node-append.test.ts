import assert from "node:assert/strict";
import { link, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { NodeFS } from "../src/node.ts";

const linux_open = {
  readwrite: 0x2,
  append: 0x400,
} as const;

const temporary = await mkdtemp(path.join(tmpdir(), "linux-guest-append-"));
after(() => rm(temporary, { recursive: true, force: true }));

function text(value: string) {
  return new TextEncoder().encode(value);
}

test("an append-open handle uses one positional sidecar when F_SETFL clears append", async () => {
  const directory = await mkdtemp(path.join(temporary, "toggle-"));
  await writeFile(path.join(directory, "file"), "seed");
  const fs = new NodeFS(directory);
  const node = (await fs.lookup(fs.root, "file"))!;
  const handle = await fs.open(node, linux_open.readwrite | linux_open.append);

  try {
    assert.equal(await fs.write(node, handle, 0n, text("A"), linux_open.readwrite), 1);
    assert.equal(await readFile(path.join(directory, "file"), "utf8"), "Aeed");
    assert.equal(node.files.size, 2);

    assert.equal(
      await fs.write(node, handle, 0n, text("B"), linux_open.readwrite | linux_open.append),
      1,
    );
    assert.equal(await readFile(path.join(directory, "file"), "utf8"), "AeedB");
    assert.equal(await fs.write(node, handle, 1n, text("C"), linux_open.readwrite), 1);
    assert.equal(await readFile(path.join(directory, "file"), "utf8"), "ACedB");

    for (let index = 0; index < 6; index++) {
      await fs.write(node, handle, 0n, text("X"), linux_open.readwrite | linux_open.append);
      await fs.write(node, handle, 1n, text("C"), linux_open.readwrite);
    }
    assert.equal(node.files.size, 2, "repeated toggles reuse the cached sidecar");
    assert.equal(await readFile(path.join(directory, "file"), "utf8"), `ACedB${"X".repeat(6)}`);
  } finally {
    await fs.release(node, handle);
  }

  assert.equal(node.files.size, 0, "release closes and forgets both descriptors");
});

test("create preserves its original append flag for later writes", async () => {
  const directory = await mkdtemp(path.join(temporary, "create-"));
  const fs = new NodeFS(directory);
  const created = await fs.create(fs.root, "created", linux_open.readwrite | linux_open.append, {
    mode: 0o100600,
    uid: process.getuid!(),
    gid: process.getgid!(),
  });
  try {
    await fs.write(
      created.node,
      created.handle,
      0n,
      text("seed"),
      linux_open.readwrite | linux_open.append,
    );
    await fs.write(created.node, created.handle, 0n, text("A"), linux_open.readwrite);
    assert.equal(await readFile(path.join(directory, "created"), "utf8"), "Aeed");
    assert.equal(created.node.files.size, 2);
  } finally {
    await fs.release(created.node, created.handle);
  }
  assert.equal(created.node.files.size, 0);
});

test(
  "append clearing writes the held inode after its host pathname is replaced",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(path.join(temporary, "replaced-inode-"));
    const filePath = path.join(directory, "file");
    const aliasPath = path.join(directory, "held-alias");
    const stagingPath = path.join(directory, "staging");
    await writeFile(filePath, "seed");
    await link(filePath, aliasPath);
    await writeFile(stagingPath, "replacement");

    const fs = new NodeFS(directory);
    const node = (await fs.lookup(fs.root, "file"))!;
    const handle = await fs.open(node, linux_open.readwrite | linux_open.append);
    try {
      await rename(stagingPath, filePath);
      await fs.write(node, handle, 0n, text("A"), linux_open.readwrite);
      assert.equal(await readFile(aliasPath, "utf8"), "Aeed");
      assert.equal(await readFile(filePath, "utf8"), "replacement");
      assert.equal(node.files.size, 2);

      for (let index = 0; index < 4; index++) {
        await fs.write(node, handle, 0n, text("X"), linux_open.readwrite | linux_open.append);
        await fs.write(node, handle, 1n, text("C"), linux_open.readwrite);
      }
      assert.equal(node.files.size, 2, "the replaced path never creates extra sidecars");
      assert.equal(await readFile(aliasPath, "utf8"), `ACed${"X".repeat(4)}`);
      assert.equal(await readFile(filePath, "utf8"), "replacement");
    } finally {
      await fs.release(node, handle);
    }
    assert.equal(node.files.size, 0);
  },
);
